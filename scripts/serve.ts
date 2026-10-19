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
import { DEFAULT_NODE_URL, Snapchain, getHomeFeed, getProfile, toDate } from "./snapchain.js";

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
    const attributed = await attribute(node, feed, resolver);

    const authors = [...new Set(attributed.map((c) => c.data.fid))];
    const profiles = new Map<number, Awaited<ReturnType<typeof getProfile>>>();
    await Promise.all(
      authors.map(async (a) => profiles.set(a, await getProfile(node, a))),
    );

    return send(res, 200, {
      casts: attributed.map((c) => ({
        hash: c.hash,
        fid: c.data.fid,
        author: profiles.get(c.data.fid)?.username ?? `fid:${c.data.fid}`,
        displayName: profiles.get(c.data.fid)?.displayName ?? null,
        pfp: profiles.get(c.data.fid)?.pfpUrl ?? null,
        text: c.data.castAddBody?.text ?? "",
        timestamp: toDate(c.data.timestamp).toISOString(),
        client: c.client,
      })),
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
