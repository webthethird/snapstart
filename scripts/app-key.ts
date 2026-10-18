/**
 * Issuing an app key, gaslessly.
 *
 * An app key (a "signer") is an Ed25519 keypair that signs Snapchain messages on
 * behalf of one FID. It is not the account. It cannot transfer custody, cannot
 * change the recovery address, and can be revoked at any time. That separation is
 * the whole point: your custody phrase authorizes a key once, and from then on the
 * client only ever holds the key.
 *
 * Registration used to require an Optimism transaction to the KeyRegistry. Under
 * FIP-272 it does not: you submit a KEY_ADD message to a Snapchain node, authorized
 * by an EIP-712 signature from the custody address. No gas, confirms in about a
 * second.
 *
 * Three signatures are involved, which is the part that trips people up:
 *
 *   1. SignedKeyRequest  — the requesting app says "I asked for this key"
 *   2. KeyAdd            — the custody address says "I authorize this key, with
 *                          these scopes, this TTL, at this nonce"
 *   3. the message envelope itself, signed by the new Ed25519 key — proof that
 *      whoever is submitting actually holds the key they are registering
 *
 * @farcaster/core's makeKeyAddBody produces (1) and (2). We produce (3) at submit
 * time.
 *
 * THE TRAP: Eip712Signer carries both the onchain and the gasless helpers, under
 * near-identical names — signKeyRequest vs signGaslessKeyRequest,
 * getSignedKeyRequestMetadata vs getGaslessSignedKeyRequestMetadata. They sign
 * different EIP-712 domains and are not interchangeable. The gasless domain is
 * { name: "Farcaster KeyAdd", version: "1", chainId: 1 } with no verifyingContract.
 * chainId 1 is cosmetic (wallets display it); nothing about this is verified on
 * Ethereum mainnet, and nothing is verified onchain at all. Using makeKeyAddBody
 * keeps you on the right side of this automatically.
 */
import { randomBytes } from "node:crypto";
import {
  MAX_KEY_TTL_SECONDS,
  MessageType,
  NobleEd25519Signer,
  ViemLocalEip712Signer,
  makeKeyAddBody,
  toFarcasterTime,
  type KeyAddBody,
} from "@farcaster/core";
import { mnemonicToAccount } from "viem/accounts";

/**
 * Scopes a general-purpose social client needs. A key scoped to CAST_ADD cannot
 * publish a LINK_ADD — request only what the client will actually use, so a leaked
 * key is worth as little as possible.
 */
export const CLIENT_SCOPES: MessageType[] = [
  MessageType.CAST_ADD,
  MessageType.CAST_REMOVE,
  MessageType.REACTION_ADD,
  MessageType.REACTION_REMOVE,
  MessageType.LINK_ADD,
  MessageType.LINK_REMOVE,
];

export type IssuedAppKey = {
  /** Keep secret. This is what the client signs with from now on. */
  privateKey: Uint8Array;
  /** The registered public key, 32 bytes. */
  publicKey: Uint8Array;
  /** Signed authorization, ready to wrap in a KEY_ADD message and submit. */
  body: KeyAddBody;
};

export type IssueOptions = {
  /** Custody mnemonic. Used once, here, then should go out of scope. */
  mnemonic: string;
  /** The FID this key will sign for. */
  fid: bigint;
  /**
   * Must be strictly greater than the FID's current user nonce, which you read
   * from a node. Replay protection — a KEY_ADD at a stale nonce is rejected.
   */
  nonce: number;
  /** Sliding expiry, refreshed on each use. Capped at 90 days. */
  ttlSeconds?: number;
  /** How long the custody authorization itself stays valid. Short by design. */
  authorizationWindowSeconds?: number;
  scopes?: MessageType[];
};

export async function issueAppKey(options: IssueOptions): Promise<IssuedAppKey> {
  const {
    mnemonic,
    fid,
    nonce,
    ttlSeconds = MAX_KEY_TTL_SECONDS,
    authorizationWindowSeconds = 3600,
    scopes = CLIENT_SCOPES,
  } = options;

  if (ttlSeconds <= 0 || ttlSeconds > MAX_KEY_TTL_SECONDS) {
    throw new Error(`ttlSeconds must be in (0, ${MAX_KEY_TTL_SECONDS}]`);
  }
  if (scopes.length === 0) {
    throw new Error("A key with no scopes can sign nothing.");
  }

  // A fresh Ed25519 keypair. This never leaves the machine that created it, and
  // it is the only credential the running client needs.
  const privateKey = new Uint8Array(randomBytes(32));
  const ed25519Signer = new NobleEd25519Signer(privateKey);
  const signerKeyResult = await ed25519Signer.getSignerKey();
  if (signerKeyResult.isErr()) throw signerKeyResult.error;
  const publicKey = signerKeyResult.value;

  // The custody key authorizes the above. ViemLocalEip712Signer wraps a local
  // viem account; nothing is sent anywhere.
  const custodySigner = new ViemLocalEip712Signer(mnemonicToAccount(mnemonic));

  // Farcaster time, not Unix time. The epoch is 2021-01-01, and the node compares
  // this against the enclosing message's timestamp. Passing Date.now()/1000 here
  // yields a deadline roughly fifty years in the future, which the node rejects.
  const nowResult = toFarcasterTime(Date.now());
  if (nowResult.isErr()) throw nowResult.error;
  const deadline = nowResult.value + authorizationWindowSeconds;

  const bodyResult = await makeKeyAddBody(
    {
      fid,
      key: publicKey,
      scopes,
      ttl: ttlSeconds,
      nonce,
      deadline,
      // requestFid defaults to fid. A client issuing keys for its own users would
      // set this to the client's own FID, which is what makes a cast attributable
      // to that client later on.
    },
    custodySigner,
  );
  if (bodyResult.isErr()) throw bodyResult.error;

  return { privateKey, publicKey, body: bodyResult.value };
}
