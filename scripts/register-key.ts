/**
 * Register a gasless app key with the network, and confirm it actually landed.
 *
 * The confirmation is the point. A read node accepts `submitMessage`, validates
 * it, hands it to the gossip layer, and returns 200 — but the gossip result is
 * discarded (mempool.rs: `gossip_message` returns no Result, and the HTTP reply
 * is computed before it runs). A freshly started node with no peers logs
 * `InsufficientPeers` and drops the message, still returning 200.
 *
 * So a 200 means "well-formed and handed off", nothing more. The only real
 * confirmation is reading the key back from the node.
 */
import {
  FarcasterNetwork,
  Message,
  NobleEd25519Signer,
  makeKeyAdd,
} from "@farcaster/core";
import { Snapchain } from "./snapchain.js";
import { issueAppKey, type IssueOptions } from "./app-key.js";

/** Measured at the chain tip: ~1.01s per block. 20s is ~20 blocks of margin. */
const CONFIRM_TIMEOUT_MS = 20_000;
const CONFIRM_INTERVAL_MS = 1_000;

export type RegisteredKey = {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  /** Hex, as the node reports it. */
  publicKeyHex: string;
  nonce: number;
  confirmed: boolean;
};

export class KeyRegistrationError extends Error {}

/**
 * Reads the FID's current nonce, issues a key, submits it, and waits for the
 * node to report it.
 *
 * `requestFid` defaults to the account's own FID, which makes the key
 * self-issued — attribution will show it as "self" rather than naming a
 * third-party app. A real client would pass its own FID here so casts are
 * attributable to it.
 */
export async function registerAppKey(
  node: Snapchain,
  options: Omit<IssueOptions, "nonce"> & { network?: FarcasterNetwork },
): Promise<RegisteredKey> {
  const { fid, network = FarcasterNetwork.MAINNET } = options;

  // The next valid nonce is strictly greater than the current one. This is the
  // only place it is exposed; it is not in the published HTTP API reference.
  const signers = await node.signersByFid(Number(fid));
  const nonce = signers.currentUserNonce + 1;

  if (signers.gaslessSignerCount >= signers.gaslessSignerLimit) {
    throw new KeyRegistrationError(
      `fid ${fid} already has ${signers.gaslessSignerCount} gasless keys ` +
        `(limit ${signers.gaslessSignerLimit}). Revoke one before adding another.`,
    );
  }

  const issued = await issueAppKey({ ...options, nonce });
  const publicKeyHex = `0x${Buffer.from(issued.publicKey).toString("hex")}`;

  // The envelope is signed by the NEW key — proof that whoever submits this
  // actually holds the key being registered.
  const ed25519Signer = new NobleEd25519Signer(issued.privateKey);
  const message = await makeKeyAdd(issued.body, { fid: Number(fid), network }, ed25519Signer);
  if (message.isErr()) throw message.error;

  const bytes = Message.encode(message.value).finish();
  await node.submitMessage(bytes);

  const confirmed = await waitForKey(node, Number(fid), publicKeyHex);
  return {
    privateKey: issued.privateKey,
    publicKey: issued.publicKey,
    publicKeyHex,
    nonce,
    confirmed,
  };
}

/** Poll until the node reports the key, or give up. Never claims success blindly. */
async function waitForKey(node: Snapchain, fid: number, publicKeyHex: string): Promise<boolean> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  const wanted = publicKeyHex.toLowerCase();

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, CONFIRM_INTERVAL_MS));
    try {
      const { signers } = await node.signersByFid(fid);
      if (signers.some((s) => s.key.toLowerCase() === wanted)) return true;
    } catch {
      // A transient read failure is not a registration failure; keep polling.
    }
  }
  return false;
}
