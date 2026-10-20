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
  for (const c of visible) {
    box.append(c.replyTo ? threadEl(c) : castEl(c, { actions: true }));
  }
}

/**
 * A reply shown under the cast it answers.
 *
 * Snapchain has no thread object — a reply is just a cast carrying parentCastId,
 * and the client reconstructs the pair. The parent is rendered muted and without
 * action buttons, so it reads as context rather than as a second feed item.
 */
function threadEl(c) {
  const wrap = document.createElement("div");
  wrap.className = "thread";

  if (c.replyTo.missing) {
    const gone = document.createElement("div");
    gone.className = "cast parent gone";
    gone.textContent = `Replying to a cast that is no longer on this node (fid ${c.replyTo.fid})`;
    wrap.append(gone);
  } else {
    wrap.append(castEl(c.replyTo, { actions: false, parent: true }));
  }

  wrap.append(castEl(c, { actions: true, reply: true }));
  return wrap;
}

function castEl(c, { actions = true, parent = false, reply = false } = {}) {
  const el = document.createElement("article");
  el.className = `cast${parent ? " parent" : ""}${reply ? " reply" : ""}`;

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
  el.append(head);

  if (c.parentUrl && !parent) {
    // A reply addressed to a channel rather than to a cast.
    const ch = document.createElement("p");
    ch.className = "cast-channel";
    ch.textContent = `in ${c.parentUrl}`;
    el.append(ch);
  }

  const text = document.createElement("p");
  text.className = "cast-text";
  text.textContent = c.text;           // textContent, never innerHTML
  el.append(text);

  if (actions) {
    const bar = document.createElement("div");
    bar.className = "actions";
    bar.append(
      actionButton("♡ like", () => react(c, "like")),
      actionButton("↻ recast", () => react(c, "recast")),
    );
    el.append(bar);
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
