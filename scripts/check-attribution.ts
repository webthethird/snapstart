/**
 * Resolve the originating client for a real account's casts, against a live node.
 *
 * Needs a running node (./snapstart tunnel). This is deliberately separate from
 * the offline suite in test-attribution.ts: that one proves the filter logic and
 * the metadata decode without a network; this one proves the response shapes are
 * what we think they are. Both matter, and only one can run in CI.
 *
 *   npx tsx scripts/check-attribution.ts [fid]
 */
import { ClientResolver, attribute, clientBreakdown, filterByClient } from "./attribution.js";
import { Snapchain, getProfile, toDate } from "./snapchain.js";

const fid = Number(process.argv[2] ?? 374565);
const node = new Snapchain();

const profile = await getProfile(node, fid);
console.log(`\nfid ${fid}  ${profile.username ?? profile.displayName ?? "(no profile)"}\n`);

const signers = await node.signersByFid(fid);
console.log(`  signers registered   ${signers.signers.length}`);
console.log(`  gasless count/limit  ${signers.gaslessSignerCount}/${signers.gaslessSignerLimit}`);
console.log(`  currentUserNonce     ${signers.currentUserNonce}`);
console.log(`  (next KEY_ADD nonce must be > ${signers.currentUserNonce})\n`);

const { messages } = await node.castsByFid(fid, { pageSize: 25 });
if (messages.length === 0) {
  console.log("  no casts found for this fid");
  process.exit(0);
}

const resolver = new ClientResolver(node);
const attributed = await attribute(node, messages, resolver);

console.log(`  ${attributed.length} most recent casts:\n`);
for (const cast of attributed.slice(0, 8)) {
  const who = cast.client.name ?? (cast.client.requestFid ? `fid:${cast.client.requestFid}` : "unknown");
  const text = (cast.data.castAddBody?.text ?? "").replace(/\s+/g, " ").slice(0, 44);
  console.log(
    `  ${toDate(cast.data.timestamp).toISOString().slice(0, 16)}  ` +
      `${who.padEnd(14)} ${cast.client.source.padEnd(8)} ${text}`,
  );
}

console.log("\n  breakdown by client:");
for (const [name, count] of clientBreakdown(attributed)) {
  console.log(`    ${String(count).padStart(3)}  ${name}`);
}

// The bounty's actual requirement: include/exclude by originating client.
const names = [...clientBreakdown(attributed).keys()].filter((n) => n !== "unknown client");
if (names.length > 0) {
  const target = names[0]!;
  const only = filterByClient(attributed, { include: [target] });
  const without = filterByClient(attributed, { exclude: [target] });
  console.log(`\n  include ["${target}"] -> ${only.length}/${attributed.length} casts`);
  console.log(`  exclude ["${target}"] -> ${without.length}/${attributed.length} casts`);
  console.log(
    `  partition is exact:   ${only.length + without.length === attributed.length ? "yes" : "NO — casts were lost"}`,
  );
}
console.log();
