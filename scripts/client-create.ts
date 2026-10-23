/**
 * Step 2: issue this client its own app key, then hand off to the UI.
 *
 * The seed phrase is read from a hidden prompt, used once, and never written
 * anywhere. Only the Ed25519 app key is persisted — it is scoped to six message
 * types, expires in 90 days, and can be revoked without touching the account.
 *
 * It is never sent to the server either. Everything here runs on your machine;
 * the node only ever sees the resulting KEY_ADD message.
 */
import { appendFile, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { mnemonicToAccount } from "viem/accounts";
import { Snapchain } from "./snapchain.js";
import { registerAppKey } from "./register-key.js";

const ENV_PATH = new URL("../.env", import.meta.url).pathname;

/** Prompt without echoing. A seed phrase should not end up in a scrollback buffer. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const asRaw = stdout as unknown as { write: (s: string) => boolean };
    // Swallow echo while the answer is being typed.
    const original = asRaw.write.bind(stdout);
    let muted = false;
    (stdout as unknown as { write: (s: string) => boolean }).write = (s: string) =>
      muted ? true : original(s);
    rl.question(question, (answer) => {
      (stdout as unknown as { write: (s: string) => boolean }).write = original;
      stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
    muted = true;
  });
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

const node = new Snapchain();

// --- 1. the node has to be genuinely ready, not merely answering ------------

let info: Awaited<ReturnType<typeof node.info>>;
try {
  info = await node.info();
} catch {
  console.error(
    "\nCannot reach your node at 127.0.0.1:3381.\n" +
      "  Open the tunnel in another terminal:  ./snapstart tunnel\n" +
      "  Still restoring?                      ./snapstart node status\n",
  );
  process.exit(1);
}

type ShardInfo = { shardId: number; blockDelay: number };
const shardsOf = (i: unknown) => ((i as { shardInfos?: ShardInfo[] }).shardInfos ?? []);

const shards = shardsOf(info);
const worstDelay = shards.reduce((m, s) => Math.max(m, s.blockDelay), 0);
const hasShardZero = shards.some((s) => s.shardId === 0);

if (!hasShardZero || worstDelay >= 100) {
  // The node answers /v1/info as soon as the snapshot is unpacked, but the
  // snapshot is hours old by the time it finishes — so it then replays blocks
  // up to the tip. That gap is invisible unless you say so, and it is the point
  // where a restore that worked perfectly looks broken.
  console.error(
    "\n  Your node is serving, but it has not caught up to the network yet.\n\n" +
      "  The snapshot it restored was already several hours old when the restore\n" +
      "  finished, so it is now replaying blocks to reach the tip. Nothing is wrong;\n" +
      "  it just is not usable yet.\n",
  );

  // A second sample turns "it is behind" into "it is behind, and here is when
  // that stops being true".
  const SAMPLE_MS = 12_000;
  // A plain line, not an erased progress indicator: carriage returns are literal
  // once this is piped to a file or a log, and the half-erased line is worse
  // than no animation.
  console.error(`  measuring how fast it is catching up (${SAMPLE_MS / 1000}s)\u2026\n`);
  await new Promise((r) => setTimeout(r, SAMPLE_MS));
  let later: ShardInfo[] = [];
  try {
    later = shardsOf(await node.info());
  } catch {
    // Fall through: still worth printing the delays we have.
  }
  let slowestEtaMin = 0;
  let anyStalled = false;
  for (const s of [...shards].sort((a, b) => a.shardId - b.shardId)) {
    const then = later.find((l) => l.shardId === s.shardId);
    if (s.blockDelay < 100) {
      console.error(`  shard ${s.shardId}: at the tip`);
      continue;
    }
    const rate = then ? (s.blockDelay - then.blockDelay) / (SAMPLE_MS / 1000) : 0;
    if (rate <= 0) {
      anyStalled = true;
      console.error(`  shard ${s.shardId}: ${s.blockDelay} blocks behind, not catching up`);
      continue;
    }
    const etaMin = (then!.blockDelay - 100) / rate / 60;
    slowestEtaMin = Math.max(slowestEtaMin, etaMin);
    console.error(
      `  shard ${s.shardId}: ${then!.blockDelay} blocks behind, ` +
        `closing ${rate.toFixed(1)}/s, about ${Math.max(1, Math.round(etaMin))} min`,
    );
  }

  if (!hasShardZero) {
    console.error(
      "\n  Shard 0 is missing entirely, which is different from being behind.\n" +
        "  App key registration routes there, so no key can be issued until it exists.\n",
    );
  } else if (anyStalled) {
    console.error(
      "\n  A shard that is not closing the gap usually means no gossip peers.\n" +
        "  Check ./snapstart node status\n",
    );
  } else {
    const t = new Date(Date.now() + slowestEtaMin * 60_000);
    console.error(
      `\n  Try again in about ${Math.max(1, Math.round(slowestEtaMin))} minutes ` +
        `(around ${t.toTimeString().slice(0, 5)} local).\n\n` +
        "  Watch it close:  ./snapstart node ready\n",
    );
  }
  process.exit(1);
}

// --- 2. which account ------------------------------------------------------

const envFid = process.env.TEST_FID;
const fidAnswer = envFid ?? (await ask("Your FID: "));
const fid = Number(fidAnswer);
if (!Number.isFinite(fid) || fid <= 0) {
  console.error("That is not a valid FID.");
  process.exit(1);
}

const signers = await node.signersByFid(fid);
console.log(`\n  fid ${fid}`);
console.log(`  existing signers   ${signers.signers.length}`);
console.log(`  gasless keys       ${signers.gaslessSignerCount}/${signers.gaslessSignerLimit}`);

// --- 3. the seed phrase, used once -----------------------------------------

console.log(
  "\n  Your seed phrase authorizes one app key and is then discarded.\n" +
    "  It is not written to disk and never leaves this machine.\n" +
    "\n  Use a throwaway account. A client holding your seed phrase could transfer\n" +
    "  your account away; a client holding only an app key cannot.\n",
);

const mnemonic = await promptHidden("  Seed phrase (hidden): ");
if (mnemonic.split(/\s+/).length < 12) {
  console.error("  That does not look like a seed phrase.");
  process.exit(1);
}

// --- 4. does this seed actually control that account? ----------------------

// Checked before submitting, because the failure is otherwise indistinguishable
// from a network problem: the node accepts the message, returns 200, gossips it,
// and a validator silently drops it for a bad signature. You wait 20 seconds and
// are told the key "never landed", which points at the node rather than the seed.
const custody = mnemonicToAccount(mnemonic).address;
let custodiedFid: number | undefined;
try {
  custodiedFid = (await node.onChainIdRegistryEventByAddress(custody)).fid;
} catch {
  custodiedFid = undefined;
}

if (custodiedFid !== fid) {
  console.error(
    `\n  That seed phrase does not control fid ${fid}.\n\n` +
      `    the seed controls   ${custody}\n` +
      (custodiedFid
        ? `    which custodies     fid ${custodiedFid}\n`
        : `    which custodies     no fid\n`) +
      `\n  Nothing was submitted. Either run this for fid ${custodiedFid ?? "<the right one>"},\n` +
      `  or use the seed phrase whose address custodies fid ${fid}.\n\n` +
      `  If the account was transferred to a new custody address, the phrase you\n` +
      `  need is the one for that address, not the one it was created with.\n`,
  );
  process.exit(1);
}

// --- 5. issue, submit, and confirm it actually landed ----------------------

console.log("\n  Issuing an app key and submitting it…");
const started = Date.now();
const key = await registerAppKey(node, { mnemonic, fid: BigInt(fid) });
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

if (!key.confirmed) {
  console.error(
    `\n  Submitted, but your node never reported the key after ${elapsed}s.\n` +
      "  A 200 from submitMessage only means the message was well-formed and handed\n" +
      "  to the gossip layer — it does not mean it landed. If the node started very\n" +
      "  recently it may not have gossip peers yet. Wait a minute and try again.\n",
  );
  process.exit(1);
}

console.log(`  confirmed in ${elapsed}s`);
console.log(`  public key   ${key.publicKeyHex}`);

// --- 6. persist the key, never the phrase ----------------------------------

const existing = await readFile(ENV_PATH, "utf8").catch(() => "");
if (/^APP_KEY_PRIVATE=/m.test(existing)) {
  console.log("\n  .env already has an APP_KEY_PRIVATE; leaving it in place.");
  console.log(`  New key: 0x${Buffer.from(key.privateKey).toString("hex")}`);
} else {
  await appendFile(
    ENV_PATH,
    `\nTEST_FID=${fid}\nAPP_KEY_PRIVATE=0x${Buffer.from(key.privateKey).toString("hex")}\n` +
      `APP_KEY_PUBLIC=${key.publicKeyHex}\n`,
  );
  console.log("  saved to .env (gitignored)");
}

console.log("\n  Done.");
