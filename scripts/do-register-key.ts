/**
 * One-shot harness: register a gasless app key for the test account.
 *
 * Reads TEST_MNEMONIC from .env. The real `client create` command prompts for
 * the phrase instead — a seed phrase on disk is acceptable for a throwaway
 * development account and not a pattern to copy.
 *
 *   npx tsx --env-file-if-exists=.env scripts/do-register-key.ts
 */
import { MessageType } from "@farcaster/core";
import { Snapchain } from "./snapchain.js";
import { registerAppKey } from "./register-key.js";

const mnemonic = process.env.TEST_MNEMONIC;
const fid = process.env.TEST_FID;
if (!mnemonic || !fid) {
  console.error("Need TEST_MNEMONIC and TEST_FID in .env");
  process.exit(1);
}

const node = new Snapchain();

const before = await node.signersByFid(Number(fid));
console.log(`fid ${fid}`);
console.log(`  signers before     ${before.signers.length}`);
console.log(`  currentUserNonce   ${before.currentUserNonce}`);
console.log(`  submitting KEY_ADD with nonce ${before.currentUserNonce + 1}...\n`);

const started = Date.now();
const key = await registerAppKey(node, { mnemonic, fid: BigInt(fid) });
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log(`  public key   ${key.publicKeyHex}`);
console.log(`  nonce        ${key.nonce}`);
console.log(`  confirmed    ${key.confirmed ? `yes (${elapsed}s)` : `NO — not visible after ${elapsed}s`}`);

const after = await node.signersByFid(Number(fid));
console.log(`\n  signers after      ${after.signers.length}`);
console.log(`  gaslessSignerCount ${after.gaslessSignerCount}`);
console.log(`  currentUserNonce   ${after.currentUserNonce}`);

const mine = after.signers.find((s) => s.key.toLowerCase() === key.publicKeyHex.toLowerCase());
if (mine) {
  console.log(`  source             ${mine.source}`);
}

if (key.confirmed) {
  console.log(`\nAdd to .env:\n  APP_KEY_PRIVATE=0x${Buffer.from(key.privateKey).toString("hex")}`);
  console.log(`  APP_KEY_PUBLIC=${key.publicKeyHex}`);
  console.log(
    `\nScopes: ${[
      MessageType.CAST_ADD,
      MessageType.CAST_REMOVE,
      MessageType.REACTION_ADD,
      MessageType.REACTION_REMOVE,
      MessageType.LINK_ADD,
      MessageType.LINK_REMOVE,
    ]
      .map((s) => MessageType[s])
      .join(", ")}`,
  );
} else {
  console.log("\nNot confirmed. The node returned 200 but the key never appeared —");
  console.log("which is exactly the failure mode a 200 cannot distinguish from success.");
}
