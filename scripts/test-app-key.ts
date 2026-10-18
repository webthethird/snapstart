/**
 * Smoke test for gasless app key issuance. No node and no funds required — it
 * builds the authorization against a throwaway mnemonic and checks the shape.
 *
 * This proves the signatures are well-formed. It does NOT prove the network will
 * accept them; only submitting a KEY_ADD and reading the key back from a node
 * does that. Local validity is necessary, not sufficient.
 */
import { MAX_KEY_TTL_SECONDS, MessageType } from "@farcaster/core";
import { english, generateMnemonic } from "viem/accounts";
import { CLIENT_SCOPES, issueAppKey } from "./app-key.js";

const mnemonic = generateMnemonic(english);
const key = await issueAppKey({ mnemonic, fid: 1n, nonce: 1 });

const checks: [string, boolean][] = [
  ["public key is 32 bytes", key.publicKey.length === 32],
  ["private key is 32 bytes", key.privateKey.length === 32],
  ["body carries the same key", Buffer.compare(Buffer.from(key.body.key), Buffer.from(key.publicKey)) === 0],
  ["keyType is Ed25519 (1)", key.body.keyType === 1],
  ["scopes match what we asked for", key.body.scopes.length === CLIENT_SCOPES.length],
  ["ttl is the 90-day max", key.body.ttl === MAX_KEY_TTL_SECONDS],
  ["custody signature present", key.body.custodySignature?.length > 0],
  ["signed key request metadata present", key.body.metadata?.length > 0],
  ["metadataType is SignedKeyRequest (1)", key.body.metadataType === 1],
  ["deadline is in Farcaster seconds, not Unix", key.body.deadline < 1_000_000_000],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed++;
}

console.log(`\n  scopes: ${key.body.scopes.map((s) => MessageType[s]).join(", ")}`);
console.log(`  ttl:    ${key.body.ttl}s (${(key.body.ttl / 86400).toFixed(0)} days, sliding)`);
console.log(`  nonce:  ${key.body.nonce}`);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAuthorization builds cleanly. Network acceptance still unproven.");
