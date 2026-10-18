/**
 * Offline tests for client attribution. No node required.
 *
 * The metadata blob here is real — produced by issueAppKey and ABI-encoded by
 * @farcaster/core — so the decode path is exercised against genuine bytes rather
 * than a hand-written fixture. The filter tests cover the cases that matter most
 * in practice: casts whose client cannot be determined, and the precedence between
 * include and exclude.
 */
import { decodeGaslessSignedKeyRequestMetadata } from "@farcaster/core";
import { english, generateMnemonic } from "viem/accounts";
import { issueAppKey } from "./app-key.js";
import {
  clientBreakdown,
  filterByClient,
  UNKNOWN_CLIENT,
  type AttributedCast,
  type ClientInfo,
} from "./attribution.js";

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => checks.push([label, ok]);

// --- the decode path, against real encoded metadata ------------------------

const key = await issueAppKey({
  mnemonic: generateMnemonic(english),
  fid: 3355268n,
  nonce: 1,
});

const decoded = decodeGaslessSignedKeyRequestMetadata(key.body.metadata);
check("real metadata decodes", decoded.isOk());
if (decoded.isOk()) {
  check(
    "requestFid is recoverable from the blob",
    Number(decoded.value.requestFid) === 3355268,
  );
  check(
    "a self-issued key names its own fid as requester",
    decoded.value.requestFid === 3355268n,
  );
}

// --- filter semantics ------------------------------------------------------

const cast = (fid: number, client: ClientInfo): AttributedCast =>
  ({
    hash: `0x${fid.toString(16)}`,
    signer: `0xsigner${fid}`,
    data: { fid, timestamp: 1, type: "MESSAGE_TYPE_CAST_ADD", castAddBody: { text: "" } },
    client,
  }) as unknown as AttributedCast;

const warpcast: ClientInfo = { requestFid: 9152, name: "warpcast", source: "gasless" };
const supercast: ClientInfo = { requestFid: 1001, name: "supercast", source: "gasless" };
const mine: ClientInfo = { requestFid: 3355268, name: "snapstart", source: "self" };

const feed = [cast(1, warpcast), cast(2, supercast), cast(3, mine), cast(4, UNKNOWN_CLIENT)];

check("no filter keeps everything", filterByClient(feed, {}).length === 4);

check(
  "exclude removes just that client",
  filterByClient(feed, { exclude: ["warpcast"] }).length === 3,
);

check(
  "exclude matches by fid as well as name",
  filterByClient(feed, { exclude: [9152] }).length === 3,
);

check(
  "exclude is case-insensitive",
  filterByClient(feed, { exclude: ["WarpCast"] }).length === 3,
);

check(
  "include keeps only the named clients",
  filterByClient(feed, { include: ["warpcast", "supercast"] }).length === 2,
);

// Unattributable casts must not silently vanish just because a lookup failed —
// but under an explicit include they are not what was asked for either. Default
// is to drop, with keepUnknown to override.
check(
  "include drops unknown-client casts by default",
  filterByClient(feed, { include: ["warpcast"] }).every((c) => c.client.source !== "unknown"),
);

check(
  "keepUnknown preserves them",
  filterByClient(feed, { include: ["warpcast"], keepUnknown: true }).length === 2,
);

check(
  "exclude beats include for the same client",
  filterByClient(feed, { include: ["warpcast"], exclude: ["warpcast"] }).length === 0,
);

check(
  "self-issued keys are filterable like any other client",
  filterByClient(feed, { include: ["snapstart"] }).length === 1,
);

// --- breakdown -------------------------------------------------------------

const breakdown = clientBreakdown([...feed, cast(5, warpcast)]);
check("breakdown counts repeats", breakdown.get("warpcast") === 2);
check("breakdown labels unattributable casts", breakdown.get("unknown client") === 1);
check(
  "breakdown is sorted by frequency",
  [...breakdown.values()][0] === 2,
);

// --- report ----------------------------------------------------------------

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed++;
}

console.log("\n  breakdown of the sample feed:");
for (const [name, count] of breakdown) console.log(`    ${count}  ${name}`);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nFilter logic and metadata decode verified offline.");
console.log("Live /v1/signer response shapes still need confirming against the node.");
