// Talks only to the local server on 127.0.0.1, which talks to your node.
// No third party is involved in any request this page makes.

const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
};

let casts = [];
let excluded = new Set();   // client names the user has unticked
let showMedia = localStorage.getItem("snapstart.media") !== "0";

const relative = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

function toast(message, bad = false) {
  const el = document.createElement("div");
  el.className = `toast${bad ? " bad" : ""}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// --- status -----------------------------------------------------------------

async function refreshStatus() {
  const dot = $("dot"), text = $("statusText"), detail = $("nodeDetail");
  try {
    const s = await api("/api/status");
    if (!s.reachable) {
      dot.className = "dot bad";
      text.textContent = "node unreachable";
      detail.innerHTML = "Is the tunnel open?<br><code>./snapstart tunnel</code>";
      return s;
    }
    dot.className = `dot ${s.ready ? "ok" : "warn"}`;
    text.textContent = s.ready ? "node ready" : "node syncing";
    detail.innerHTML =
      `version ${s.version}<br>` +
      s.shards.sort((a, b) => a.shardId - b.shardId)
        .map((sh) => `shard ${sh.shardId}: delay ${sh.blockDelay}`).join("<br>") +
      (s.ready ? "" : "<br><br>Shards are still catching up. Reads work; writes may not.");
    if (!s.canWrite) {
      $("composePanel").innerHTML =
        '<h2 class="sec">New cast</h2><p class="hint">No app key configured. Run <code>./snapstart client create</code> to post.</p>';
    }
    return s;
  } catch (err) {
    dot.className = "dot bad";
    text.textContent = "local server error";
    detail.textContent = err.message;
  }
}

// --- feed -------------------------------------------------------------------

function clientLabel(c) {
  if (c.name) return c.name;
  if (c.requestFid) return `fid:${c.requestFid}`;
  return "unknown client";
}

function renderFilters(breakdown) {
  const box = $("filters");
  box.innerHTML = "";
  for (const { name, count } of breakdown) {
    const row = document.createElement("label");
    row.className = "filter-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !excluded.has(name);
    cb.onchange = () => {
      cb.checked ? excluded.delete(name) : excluded.add(name);
      renderFeed();
    };
    const span = document.createElement("span");
    span.textContent = name;
    const n = document.createElement("span");
    n.className = "count";
    n.textContent = count;
    row.append(cb, span, n);
    box.append(row);
  }
}

function renderFeed() {
  const box = $("feed");
  const visible = casts.filter((c) => !excluded.has(clientLabel(c.client)));
  if (visible.length === 0) {
    box.innerHTML = `<p class="hint">No casts to show${excluded.size ? " — every source is filtered out." : "."}</p>`;
    return;
  }
  box.innerHTML = "";
  for (const group of groupIntoThreads(visible)) {
    box.append(group.length === 1 && !group[0].ancestors?.length
      ? castEl(group[0], { actions: true })
      : threadEl(group));
  }
}

/**
 * Group feed casts into conversations.
 *
 * Two replies in the same exchange share ancestors, so rendering each with its
 * own parent chain splits one conversation into several blocks that repeat the
 * same casts. Keying on the root collapses them into a single thread.
 *
 * Order is by the newest cast in each thread, so an active conversation does not
 * sink just because it started days ago.
 */
function groupIntoThreads(visible) {
  const groups = new Map();
  for (const c of visible) {
    const root = c.ancestors?.length ? c.ancestors[0] : c;
    const key = root.hash;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const out = [...groups.values()];
  out.sort((a, b) => newest(b) - newest(a));
  return out;
}

function newest(group) {
  return Math.max(...group.map((c) => new Date(c.timestamp).getTime()));
}

/**
 * One conversation: every ancestor plus every feed cast in it, in time order.
 *
 * Rendered flat with a single rail rather than nesting per level — a six-deep
 * exchange indented six times is unreadable, and ordering already carries the
 * structure.
 */
function threadEl(group) {
  const wrap = document.createElement("div");
  wrap.className = "thread";

  // Feed casts are actionable; ancestors are context pulled in to explain them.
  const inFeed = new Set(group.map((c) => c.hash));
  const nodes = new Map();
  for (const c of group) {
    for (const a of c.ancestors ?? []) {
      const key = a.missing ? `missing:${a.fid}:${a.hash}` : a.hash;
      if (!nodes.has(key)) nodes.set(key, a);
    }
    nodes.set(c.hash, c);
  }

  const ordered = [...nodes.values()].sort((a, b) => {
    if (a.missing) return -1;
    if (b.missing) return 1;
    return new Date(a.timestamp) - new Date(b.timestamp);
  });

  const render = (n) => {
    if (n.missing) {
      const gone = document.createElement("div");
      gone.className = "cast gone";
      gone.textContent = `earlier casts in this thread are no longer on this node (fid ${n.fid})`;
      return gone;
    }
    // Every cast is actionable, whether or not it came from your own feed —
    // a thread you were pulled into is exactly where you want to reply-react.
    // `context` only controls how it looks.
    return castEl(n, { actions: true, context: !inFeed.has(n.hash) });
  };

  // The cast that started the thread sits flush with every other top-level cast
  // in the feed. Everything answering it goes in one indented group sharing a
  // single rail — one level, however deep the conversation actually runs.
  const [root, ...replies] = ordered;
  wrap.append(render(root));
  if (replies.length) {
    const box = document.createElement("div");
    box.className = "thread-replies";
    for (const n of replies) box.append(render(n));
    wrap.append(box);
  }
  return wrap;
}

/** Longer casts are clamped; the rest is one click away. */
const CLAMP = 320;

/**
 * A channel reference, shortened.
 *
 * parentUrl on a channel cast is the Warpcast-era identifier: an NFT contract,
 * e.g. chain://eip155:7777777/erc721:0x4f86…7628. The human name ("/farcaster")
 * is not on the protocol — snapchain's own channel registry is keyed by a
 * 32-byte id and is empty on mainnet, and the name lives in Warpcast's API.
 * Resolving it would need exactly the API key this project does without, so
 * show the contract and keep the full URI on hover.
 */
function channelLabel(url) {
  const m = /erc721:(0x[0-9a-fA-F]{6,})/.exec(url);
  if (m) return `channel ${m[1].slice(0, 8)}…${m[1].slice(-4)}`;
  return url;
}

function castText(full) {
  const p = document.createElement("p");
  p.className = "cast-text";

  if (full.length <= CLAMP) {
    p.textContent = full;                 // textContent, never innerHTML
    return p;
  }

  const toggle = document.createElement("button");
  toggle.className = "show-more";
  let open = false;

  const draw = () => {
    p.textContent = open ? full + " " : full.slice(0, CLAMP).trimEnd() + "… ";
    toggle.textContent = open ? "Show less" : "Show more";
    p.append(toggle);
  };
  toggle.onclick = () => { open = !open; draw(); };
  draw();
  return p;
}

/**
 * Is this URL worth trying to render as an image?
 *
 * Extension alone is not enough: Warpcast's CDN serves images from paths like
 * /BXluQx4ige9GuW0Ia56BHw/<uuid>/original, with no extension at all. So check
 * the extension when there is one, and otherwise trust a short host list. Any
 * mistake is caught by onerror, which falls back to a plain link.
 */
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)(\?|#|$)/i;
const IMAGE_HOSTS = new Set([
  "imagedelivery.net",
  "i.imgur.com",
  "media.tenor.com",
  "media1.tenor.com",
]);

function looksLikeImage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return IMAGE_EXT.test(u.pathname) || IMAGE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function linkEl(url) {
  const a = document.createElement("a");
  a.className = "embed-link";
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = url;
  return a;
}

function embedsEl(embeds) {
  if (!embeds || embeds.length === 0) return null;

  const box = document.createElement("div");
  box.className = "embeds";
  let used = 0;

  for (const e of embeds) {
    // castId embeds are rendered separately, as quote cards.
    if (e.castId) continue;
    if (!e.url) continue;

    if (!looksLikeImage(e.url)) {
      box.append(linkEl(e.url));
      used++;
      continue;
    }

    if (!showMedia) {
      const off = document.createElement("p");
      off.className = "embed-quote";
      off.textContent = "image hidden — enable “Load images”";
      box.append(off);
      used++;
      continue;
    }

    const img = document.createElement("img");
    img.className = "embed-img";
    img.loading = "lazy";
    img.decoding = "async";
    // Do not tell the host which feed the request came from.
    img.referrerPolicy = "no-referrer";
    img.alt = "";
    img.src = e.url;
    // Not an image after all, or the host is gone: degrade to the link.
    img.onerror = () => img.replaceWith(linkEl(e.url));
    box.append(img);
    used++;
  }

  return used ? box : null;
}

/**
 * The author's avatar.
 *
 * Gated on the same "Load images" toggle as embeds: a profile picture is hosted
 * by whoever the author chose, so it is the same third-party request. With the
 * toggle off — or when an account has set no pfp, which every new FID starts out
 * as — this falls back to a monogram drawn locally.
 */
function avatarEl(c, { small = false } = {}) {
  const letter = (c.displayName || c.author || "?").trim()[0] || "?";

  const fallback = () => {
    const d = document.createElement("div");
    d.className = `avatar fallback${small ? " small" : ""}`;
    d.textContent = letter.toUpperCase();
    // Stable per author, so the same person keeps the same colour.
    d.style.setProperty("--hue", String((c.fid ?? 0) * 47 % 360));
    return d;
  };

  if (!showMedia || !c.pfp) return fallback();

  const img = document.createElement("img");
  img.className = `avatar${small ? " small" : ""}`;
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.alt = "";
  img.src = c.pfp;
  img.onerror = () => img.replaceWith(fallback());
  return img;
}

/**
 * A quoted cast, rendered as a card inside the quoting one.
 *
 * Resolved server-side and only one level deep: a quote card does not itself
 * render further quotes, or a chain of them would fan out without bound. Its
 * images do render, since that is usually the point of the quote.
 */
function quoteEl(q) {
  const card = document.createElement("div");
  card.className = "quote-card";

  if (q.missing) {
    card.classList.add("gone");
    card.textContent = `a quoted cast that is no longer on this node (fid ${q.fid})`;
    return card;
  }

  const head = document.createElement("div");
  head.className = "cast-head";
  const who = document.createElement("span");
  who.className = "cast-author";
  who.textContent = q.displayName || q.author;
  const meta = document.createElement("span");
  meta.className = "cast-meta";
  meta.textContent = `@${q.author} · ${relative(q.timestamp)}`;
  const chip = document.createElement("span");
  chip.className = `chip${q.client.source === "self" ? " self" : ""}`;
  chip.textContent = clientLabel(q.client);
  chip.title = `source: ${q.client.source}`;
  head.append(avatarEl(q, { small: true }), who, meta, chip);
  card.append(head, castText(q.text));

  const media = embedsEl(q.embeds);
  if (media) card.append(media);

  const bar = document.createElement("div");
  bar.className = "actions";
  bar.append(
    actionButton("♡ like", () => react(q, "like")),
    actionButton("↻ recast", () => react(q, "recast")),
  );
  card.append(bar);
  return card;
}

function castEl(c, { actions = true, context = false } = {}) {
  const el = document.createElement("article");
  el.className = `cast${context ? " context" : ""}`;
  el.append(avatarEl(c));

  // Everything but the avatar lives in this column, so long words and wide
  // code blocks wrap against it rather than pushing the row wider.
  const body = document.createElement("div");
  body.className = "cast-body";
  el.append(body);

  const head = document.createElement("div");
  head.className = "cast-head";
  const who = document.createElement("span");
  who.className = "cast-author";
  who.textContent = c.displayName || c.author;
  const meta = document.createElement("span");
  meta.className = "cast-meta";
  meta.textContent = `@${c.author} · ${relative(c.timestamp)}`;
  const chip = document.createElement("span");
  chip.className = `chip${c.client.source === "self" ? " self" : ""}`;
  chip.textContent = clientLabel(c.client);
  chip.title = `source: ${c.client.source}`;
  head.append(who, meta, chip);
  body.append(head);

  if (c.parentUrl) {
    const ch = document.createElement("p");
    ch.className = "cast-channel";
    ch.textContent = `in ${channelLabel(c.parentUrl)}`;
    ch.title = c.parentUrl;
    body.append(ch);
  }

  body.append(castText(c.text));

  const media = embedsEl(c.embeds);
  if (media) body.append(media);

  for (const q of c.quotes ?? []) body.append(quoteEl(q));

  if (actions) {
    const bar = document.createElement("div");
    bar.className = "actions";
    bar.append(
      actionButton("♡ like", () => react(c, "like")),
      actionButton("↻ recast", () => react(c, "recast")),
    );
    body.append(bar);
  }
  return el;
}

function actionButton(label, fn) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await fn();
      if (r?.confirmed) { b.classList.add("done"); toast("Confirmed by your node"); }
      else toast("Submitted, but not confirmed within 20s", true);
    } catch (e) { toast(e.message, true); b.disabled = false; }
  };
  return b;
}

const react = (c, kind) =>
  api("/api/react", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fid: c.fid, hash: c.hash, kind }),
  });

async function loadFeed() {
  try {
    const data = await api("/api/feed?limit=50");
    casts = data.casts;
    renderFilters(data.breakdown);
    renderFeed();
  } catch (err) {
    $("feed").innerHTML = `<p class="hint">Could not load the feed: ${err.message}</p>`;
  }
}

// --- actions ----------------------------------------------------------------

$("composeText").addEventListener("input", (e) => {
  $("composeCount").textContent = `${e.target.value.length} / 320`;
});

$("castBtn").onclick = async () => {
  const text = $("composeText").value.trim();
  if (!text) return;
  $("castBtn").disabled = true;
  try {
    const r = await api("/api/cast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (r.confirmed) {
      toast(`Cast confirmed in ${(r.elapsedMs / 1000).toFixed(1)}s`);
      $("composeText").value = "";
      $("composeCount").textContent = "0 / 320";
      setTimeout(loadFeed, 1200);
    } else {
      toast("Submitted, but your node never saw it. Check gossip peers.", true);
    }
  } catch (e) { toast(e.message, true); }
  $("castBtn").disabled = false;
};

$("followBtn").onclick = async () => {
  const targetFid = Number($("followFid").value);
  if (!Number.isFinite(targetFid) || targetFid <= 0) return toast("Enter a numeric FID", true);
  $("followBtn").disabled = true;
  try {
    const r = await api("/api/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetFid }),
    });
    toast(r.confirmed ? `Following ${targetFid}` : "Submitted, not confirmed", !r.confirmed);
    if (r.confirmed) { $("followFid").value = ""; setTimeout(loadFeed, 1200); }
  } catch (e) { toast(e.message, true); }
  $("followBtn").disabled = false;
};

const mediaToggle = $("mediaToggle");
if (mediaToggle) {
  mediaToggle.checked = showMedia;
  mediaToggle.onchange = () => {
    showMedia = mediaToggle.checked;
    localStorage.setItem("snapstart.media", showMedia ? "1" : "0");
    renderFeed();   // no refetch: the feed already carries the embeds
  };
}

$("allOn").onclick = () => { excluded.clear(); loadFeed(); };
$("allOff").onclick = () => {
  for (const c of casts) excluded.add(clientLabel(c.client));
  renderFilters([...new Map(casts.map((c) => [clientLabel(c.client), 0])).keys()]
    .map((name) => ({ name, count: casts.filter((c) => clientLabel(c.client) === name).length })));
  renderFeed();
};
$("refresh").onclick = async () => { await refreshStatus(); await loadFeed(); };

await refreshStatus();
await loadFeed();
