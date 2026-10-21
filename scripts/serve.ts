/**
 * The client UI, served on your own machine.
 *
 * Binds to 127.0.0.1 only. Nothing is exposed to the network: the browser talks
 * to this process, this process talks to your node through the SSH tunnel
 * (`./snapstart tunnel`), and your node is the only thing that talks to
 * Farcaster. No port is opened anywhere, and no password is needed because
 * nothing outside this machine can reach it.
 *
 * If you later want this on a phone, put the machine on a private network —
 * Tailscale, WireGuard, a VPN — and change HOST below. Do not simply bind to
 * 0.0.0.0: this process can post as you.
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "./actions.js";
import { ClientResolver, attribute, clientBreakdown, filterByClient } from "./attribution.js";
import { DEFAULT_NODE_URL, type Message, Snapchain, getHomeFeed, getProfile, toDate } from "./snapchain.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SNAPSTART_UI_PORT ?? 4173);
const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));

const node = new Snapchain(process.env.SNAPCHAIN_URL ?? DEFAULT_NODE_URL);
const fid = Number(process.env.TEST_FID ?? 0);
const appKey = process.env.APP_KEY_PRIVATE;

/** Writes need an app key; reads do not. The UI degrades rather than refusing to start. */
const client =
  appKey && fid
    ? new Client(node, fid, new Uint8Array(Buffer.from(appKey.replace(/^0x/, ""), "hex")))
    : undefined;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** One resolver for the process, so signer and app-name lookups stay cached. */
const resolver = new ClientResolver(node);

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    // This page should never be framed, and never cached across restarts.
    "x-frame-options": "DENY",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname;

  if (path === "/api/status") {
    try {
      const info = (await node.info()) as {
        version: string;
        shardInfos?: { shardId: number; blockDelay: number; maxHeight: number }[];
      };
      const shards = info.shardInfos ?? [];
      const worst = shards.reduce((m, s) => Math.max(m, s.blockDelay), 0);
      return send(res, 200, {
        reachable: true,
        version: info.version,
        shards,
        // Same rule as `./snapstart node ready`: every shard near the tip.
        ready: shards.length > 0 && worst < 100 && shards.some((s) => s.shardId === 0),
        fid,
        canWrite: Boolean(client),
      });
    } catch (err) {
      return send(res, 200, {
        reachable: false,
        fid,
        canWrite: Boolean(client),
        error: (err as Error).message,
      });
    }
  }

  if (path === "/api/feed") {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const feed = await getHomeFeed(node, fid, { limit, perAuthor: 4 });

    // Snapchain stores no thread object. A reply is a cast carrying
    // parentCastId, so a conversation is reconstructed by walking that pointer
    // to the root — which is the client's job, and worth showing plainly.
    //
    // One cache for the whole request: a six-deep exchange that appears twice in
    // a feed shares every ancestor, and without this each copy refetches them.
    const castCache = new Map<string, Message | null>();
    const getCast = async (f: number, h: string): Promise<Message | null> => {
      const key = `${f}:${h}`;
      if (castCache.has(key)) return castCache.get(key)!;
      let got: Message | null = null;
      try {
        got = await node.castById(f, h);
      } catch {
        // Deleted by its author, or pruned when their storage filled. Expected.
        got = null;
      }
      castCache.set(key, got);
      return got;
    };

    type Missing = { missing: true; fid: number; hash: string };
    const MAX_DEPTH = 25;

    /** Ancestors of a cast, root first. Stops at a missing parent or a cycle. */
    const ancestorsOf = async (cast: Message): Promise<(Message | Missing)[]> => {
      const chain: (Message | Missing)[] = [];
      const seen = new Set<string>([`${cast.data.fid}:${cast.hash}`]);
      let cur: Message = cast;
      for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const ref = cur.data.castAddBody?.parentCastId;
        if (!ref) break;
        const key = `${ref.fid}:${ref.hash}`;
        if (seen.has(key)) break; // defensive: a parent pointer that loops
        seen.add(key);
        const parent = await getCast(ref.fid, ref.hash);
        if (!parent) {
          chain.push({ missing: true, fid: ref.fid, hash: ref.hash });
          break;
        }
        chain.push(parent);
        cur = parent;
      }
      return chain.reverse();
    };

    const chains = await Promise.all(feed.map(ancestorsOf));

    // Attribute and profile the feed and every ancestor in one pass.
    const realAncestors = chains.flat().filter((m): m is Message => !("missing" in m));
    const attributed = await attribute(node, feed, resolver);
    const attributedAncestors = await attribute(node, realAncestors, resolver);
    const byHash = new Map(attributedAncestors.map((m) => [m.hash, m]));

    // Quoted casts: an embed carrying a castId rather than a url. Resolved one
    // level deep only — a quote of a quote of a quote would otherwise fan out
    // without bound, and the cache is per-request so it would not even amortise.
    const quoteRefs = new Map<string, { fid: number; hash: string }>();
    for (const c of [...attributed, ...attributedAncestors]) {
      for (const e of c.data.castAddBody?.embeds ?? []) {
        if (e.castId) quoteRefs.set(`${e.castId.fid}:${e.castId.hash}`, e.castId);
      }
    }
    const quoted = (
      await Promise.all([...quoteRefs.values()].map((r) => getCast(r.fid, r.hash)))
    ).filter((m): m is Message => m !== null);
    const attributedQuotes = await attribute(node, quoted, resolver);
    const quoteByKey = new Map(
      attributedQuotes.map((m) => [`${m.data.fid}:${m.hash}`, m]),
    );

    const authors = [
      ...new Set([
        ...attributed.map((c) => c.data.fid),
        ...attributedAncestors.map((c) => c.data.fid),
        ...attributedQuotes.map((c) => c.data.fid),
      ]),
    ];
    const profiles = new Map<number, Awaited<ReturnType<typeof getProfile>>>();
    await Promise.all(authors.map(async (a) => profiles.set(a, await getProfile(node, a))));

    const shape = (c: (typeof attributed)[number]) => ({
      hash: c.hash,
      fid: c.data.fid,
      author: profiles.get(c.data.fid)?.username ?? `fid:${c.data.fid}`,
      displayName: profiles.get(c.data.fid)?.displayName ?? null,
      pfp: profiles.get(c.data.fid)?.pfpUrl ?? null,
      text: c.data.castAddBody?.text ?? "",
      timestamp: toDate(c.data.timestamp).toISOString(),
      client: c.client,
      parentUrl: c.data.castAddBody?.parentUrl ?? null,
      // Attachments. A url embed may be an image, a video or an ordinary link;
      // a castId embed is a quoted cast. The node does not say which, so the
      // client decides what to do with each.
      embeds: c.data.castAddBody?.embeds ?? [],
    });

    /** Same as shape, plus any quoted casts resolved to real content. */
    const shapeWithQuotes = (c: (typeof attributed)[number]) => ({
      ...shape(c),
      quotes: (c.data.castAddBody?.embeds ?? []).flatMap((e) => {
        if (!e.castId) return [];
        const q = quoteByKey.get(`${e.castId.fid}:${e.castId.hash}`);
        return [
          q
            ? shape(q)
            : { missing: true as const, fid: e.castId.fid, hash: e.castId.hash },
        ];
      }),
    });

    return send(res, 200, {
      casts: attributed.map((c, i) => {
        // Root first, immediate parent last. A trailing {missing:true} means the
        // walk stopped because that cast is no longer on this node.
        const ancestors = (chains[i] ?? []).map((a) => {
          if ("missing" in a) return a;
          const withClient = byHash.get(a.hash);
          // Attribution covers every fetched ancestor, so this is belt and
          // braces: degrade to the stub rather than invent an attribution.
          return withClient
            ? shapeWithQuotes(withClient)
            : { missing: true as const, fid: a.data.fid, hash: a.hash };
        });
        return { ...shapeWithQuotes(c), ancestors };
      }),
      breakdown: [...clientBreakdown(attributed)].map(([name, count]) => ({ name, count })),
    });
  }

  if (!client) return send(res, 503, { error: "No app key configured. Run ./snapstart client create" });

  if (path === "/api/cast" && req.method === "POST") {
    const { text } = await readJson(req);
    if (typeof text !== "string" || text.trim() === "") {
      return send(res, 400, { error: "empty cast" });
    }
    return send(res, 200, await client.cast(text.trim()));
  }

  if (path === "/api/follow" && req.method === "POST") {
    const { targetFid, remove } = await readJson(req);
    const target = Number(targetFid);
    if (!Number.isFinite(target) || target <= 0) return send(res, 400, { error: "bad fid" });
    return send(res, 200, remove ? await client.unfollow(target) : await client.follow(target));
  }

  if (path === "/api/react" && req.method === "POST") {
    const { fid: targetFid, hash, kind, remove } = await readJson(req);
    return send(res, 200, await client.react(
      { fid: Number(targetFid), hash: String(hash) },
      kind === "recast" ? "recast" : "like",
      { remove: Boolean(remove) },
    ));
  }

  return send(res, 404, { error: "not found" });
}

async function serveStatic(res: ServerResponse, pathname: string) {
  // normalize + prefix check: never serve outside web/.
  const rel = normalize(pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
  const file = join(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    await stat(file);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "x-frame-options": "DENY",
  });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const run = url.pathname.startsWith("/api/")
    ? handleApi(req, res, url)
    : serveStatic(res, url.pathname);
  run.catch((err: Error) => {
    if (url.pathname.startsWith("/api/")) send(res, 500, { error: err.message });
    else res.writeHead(500).end(err.message);
  });
});

// Without this, a port clash surfaces as an unhandled 'error' event and a Node
// stack trace — which is what a second `client ui`, or anything else already on
// this port, actually looks like to someone following the tutorial.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n  Port ${PORT} is already in use.\n\n` +
        `  The client is probably already running — try http://${HOST}:${PORT} first.\n` +
        `  Otherwise stop whatever holds the port, or pick another:\n\n` +
        `    SNAPSTART_UI_PORT=4174 ./snapstart client ui\n`,
    );
    process.exit(1);
  }
  if (err.code === "EACCES") {
    console.error(`\n  Not allowed to bind port ${PORT}. Pick one above 1024.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, async () => {
  console.log(`\n  snapstart client  →  http://${HOST}:${PORT}\n`);
  console.log(`  node      ${process.env.SNAPCHAIN_URL ?? DEFAULT_NODE_URL}`);
  console.log(`  fid       ${fid || "(not set)"}`);
  console.log(`  posting   ${client ? "enabled" : "disabled — no app key"}\n`);
  try {
    await readFile(join(WEB_ROOT, "index.html"));
  } catch {
    console.log("  warning: web/index.html missing\n");
  }
});
