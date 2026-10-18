/**
 * Offline tests for gasless app key issuance. No node and no funds required.
 *
 * These cryptographically verify both EIP-712 signatures against the custody
 * address, and check that a tampered authorization fails. That is strictly more
 * than a shape check — but it still proves only that the authorization is
 * internally consistent. It does NOT prove snapchain will accept it: nonce
 * ordering, TTL bounds and scope admissibility are all enforced by the node, and
 * only a submitted KEY_ADD that reads back establishes network acceptance.
 */
import {
  MAX_KEY_TTL_SECONDS,
  MessageType,
  decodeGaslessSignedKeyRequestMetadata,
  verifyGaslessKeyRequest,
  verifyKeyAdd,
} from "@farcaster/core";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import { hexToBytes } from "viem";
import { CLIENT_SCOPES, issueAppKey } from "./app-key.js";

const mnemonic = generateMnemonic(english);
const custody = mnemonicToAccount(mnemonic);
const custodyBytes = hexToBytes(custody.address);
const FID = 1n;

const key = await issueAppKey({ mnemonic, fid: FID, nonce: 1 });
const { body } = key;

// The custody signature covers exactly these fields; reconstruct them to verify.
// Note deadline is a bigint here but a number on KeyAddBody — the EIP-712 encoder
// happens to accept either, so this mismatch does not surface at runtime.
const keyAddMessage = {
  fid: FID,
  key: body.key,
  keyType: body.keyType,
  scopes: body.scopes,
  ttl: body.ttl,
  nonce: body.nonce,
  deadline: BigInt(body.deadline),
};

const keyAddOk = await verifyKeyAdd(keyAddMessage, body.custodySignature, custodyBytes);

// The metadata blob is ABI-encoded and carries the requesting app's own signature.
const metadata = decodeGaslessSignedKeyRequestMetadata(body.metadata);
if (metadata.isErr()) throw metadata.error;
const { requestFid, requestSigner, signature, deadline } = metadata.value;

const requestOk = await verifyGaslessKeyRequest(
  { requestFid, key: body.key, deadline },
  signature,
  hexToBytes(requestSigner),
);

// A signature that still verifies after the message changed would be worthless.
const tamperedOk = await verifyKeyAdd(
  { ...keyAddMessage, ttl: keyAddMessage.ttl - 1 },
  body.custodySignature,
  custodyBytes,
);

const checks: [string, boolean][] = [
  ["public key is 32 bytes", key.publicKey.length === 32],
  ["body carries the same key", Buffer.from(body.key).equals(Buffer.from(key.publicKey))],
  ["keyType is Ed25519 (1)", body.keyType === 1],
  ["scopes match what we asked for", body.scopes.length === CLIENT_SCOPES.length],
  ["ttl is the 90-day max", body.ttl === MAX_KEY_TTL_SECONDS],
  ["metadataType is SignedKeyRequest (1)", body.metadataType === 1],
  ["deadline is Farcaster seconds, not Unix", body.deadline < 1_000_000_000],
  // The signature checks, which are the point of this file.
  ["custody signature verifies against the custody address", keyAddOk.unwrapOr(false)],
  ["requestSigner is the custody address (self-issued key)",
    requestSigner.toLowerCase() === custody.address.toLowerCase()],
  ["requestFid defaults to the key's own fid", requestFid === FID],
  ["SignedKeyRequest signature verifies", requestOk.unwrapOr(false)],
  ["a tampered ttl FAILS verification", tamperedOk.unwrapOr(false) === false],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed++;
}

console.log(`\n  scopes: ${body.scopes.map((s) => MessageType[s]).join(", ")}`);
console.log(`  ttl:    ${body.ttl}s (${(body.ttl / 86400).toFixed(0)} days, sliding)`);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nBoth signatures verify. Network acceptance is still unproven —");
console.log("that needs a submitted KEY_ADD read back from a node.");
