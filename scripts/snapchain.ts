/**
 * A read layer over a Snapchain node's HTTP API.
 *
 * Every call here goes to YOUR node. There is no hosted data API in the loop, no
 * key, and no rate limit other than what your own hardware imposes. That is the
 * entire point of running the node.
 *
 * The node serves the same data over gRPC, which is faster and supports the sync
 * APIs that HTTP does not. HTTP is plenty for a client and much easier to read, so
 * that is what this uses.
 */
import { fromFarcasterTime } from "@farcaster/core";

/**
 * Default target is localhost, because the recommended setup tunnels the node's
 * port over SSH rather than exposing it to the internet. See `./snapstart tunnel`.
 */
export const DEFAULT_NODE_URL = process.env.SNAPCHAIN_URL ?? "http://127.0.0.1:3381";

export type Paged<T> = { messages: T[]; nextPageToken?: string };

/** A Snapchain message as the HTTP API returns it (hex strings, camelCase). */
export type Message = {
  hash: string;
  hashScheme: string;
  signature: string;
  signatureScheme: string;
  /** The Ed25519 app key that signed this. The basis of client attribution. */
  signer: string;
  data: {
    type: string;
    fid: number;
    /** Farcaster seconds, not Unix seconds. */
    timestamp: number;
    network: string;
    castAddBody?: {
      text: string;
      embeds?: { url?: string; castId?: { fid: number; hash: string } }[];
      mentions?: number[];
      parentCastId?: { fid: number; hash: string };
      parentUrl?: string;
    };
    linkBody?: { type: string; targetFid?: number };
    reactionBody?: { type: string; targetCastId?: { fid: number; hash: string } };
    userDataBody?: { type: string; value: string };
  };
};

/**
 * A registered signer. `source` distinguishes the two registration paths without
 * having to infer it: SIGNER_SOURCE_ONCHAIN came from a KeyRegistry transaction,
 * gasless keys (FIP-272) report their own source.
 */
export type Signer = {
  source: string;
  key: string;
  keyType: number;
  fid: number;
  addedAt: number;
  /** Present on onchain registrations. */
  onChainEvent?: {
    signerEventBody?: {
      key: string;
      /** base64-encoded ABI SignedKeyRequestMetadata. */
      metadata?: string;
      metadataType?: number;
    };
  };
  /** Present on gasless registrations. */
  metadata?: string;
  metadataType?: number;
};

export type SignersResponse = {
  signers: Signer[];
  nextPageToken?: string;
  gaslessSignerCount: number;
  /** Matches MAX_GASLESS_KEYS_PER_FID; surfaced so clients can render "x/y". */
  gaslessSignerLimit: number;
  /**
   * The next valid KEY_ADD nonce must be STRICTLY GREATER than this. 0 means no
   * gasless activity yet, so a first key uses nonce 1.
   */
  currentUserNonce: number;
  requesterFidNonces?: Record<string, number>;
};

export class SnapchainError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
  }
}

export class Snapchain {
  constructor(private readonly baseUrl: string = DEFAULT_NODE_URL) {}

  private async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (cause) {
      // By far the most common failure for anyone following the tutorial: the node
      // is still restoring its snapshot and is not serving yet, or the SSH tunnel
      // is not up. Say so, rather than surfacing a bare ECONNREFUSED.
      throw new SnapchainError(
        `Could not reach a Snapchain node at ${this.baseUrl}.\n` +
          `  - Is the restore finished?  ./snapstart node status\n` +
          `  - Is the tunnel open?       ./snapstart tunnel`,
        undefined,
        url.toString(),
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new SnapchainError(
        `${res.status} ${res.statusText} from ${url.pathname}${body ? `: ${body.slice(0, 300)}` : ""}`,
        res.status,
        url.toString(),
      );
    }
    return (await res.json()) as T;
  }

  /** Node identity, version, and db stats. Only answers once the restore completes. */
  info() {
    return this.get<{
      version: string;
      peerId: string;
      numShards: number;
      dbStats?: { numMessages: number; numFidRegistrations: number };
    }>("/v1/info");
  }

  /**
   * Casts authored by one FID, newest first by default.
   *
   * `reverse` must be "true"/"false" — passing 1 is rejected with
   * "provided string was not `true` or `false`". The docs say this correctly;
   * an earlier version of this file did not.
   */
  castsByFid(fid: number, opts: { pageSize?: number; pageToken?: string; reverse?: boolean } = {}) {
    return this.get<Paged<Message>>("/v1/castsByFid", {
      fid,
      pageSize: opts.pageSize ?? 25,
      pageToken: opts.pageToken,
      reverse: opts.reverse === false ? undefined : true,
    });
  }

  castById(fid: number, hash: string) {
    return this.get<Message>("/v1/castById", { fid, hash });
  }

  /** Replies to a cast. */
  castsByParent(fid: number, hash: string, opts: { pageSize?: number } = {}) {
    return this.get<Paged<Message>>("/v1/castsByParent", {
      fid,
      hash,
      pageSize: opts.pageSize ?? 25,
    });
  }

  /**
   * Links from this FID. A "follow" is a LinkAdd of type `follow` — following is
   * just a message, same as a cast, which is why it costs storage.
   */
  linksByFid(fid: number, linkType = "follow", opts: { pageSize?: number; pageToken?: string } = {}) {
    return this.get<Paged<Message>>("/v1/linksByFid", {
      fid,
      link_type: linkType,
      pageSize: opts.pageSize ?? 100,
      pageToken: opts.pageToken,
    });
  }

  /** Who follows this FID. */
  linksByTargetFid(targetFid: number, linkType = "follow", opts: { pageSize?: number } = {}) {
    return this.get<Paged<Message>>("/v1/linksByTargetFid", {
      target_fid: targetFid,
      link_type: linkType,
      pageSize: opts.pageSize ?? 100,
    });
  }

  reactionsByCast(fid: number, hash: string, reactionType?: string) {
    return this.get<Paged<Message>>("/v1/reactionsByCast", {
      target_fid: fid,
      target_hash: hash,
      reaction_type: reactionType,
    });
  }

  /** Profile fields (display name, bio, pfp, username) arrive as separate messages. */
  userDataByFid(fid: number) {
    return this.get<Paged<Message>>("/v1/userDataByFid", { fid, pageSize: 20 });
  }

  /**
   * Every signer registered for one FID, plus the nonce state needed to add
   * another. Shapes below were taken from a live node, not from documentation —
   * `/v1/signersByFid` is absent from the published HTTP API reference.
   *
   * Note `metadata` is base64, not the hex the rest of this API uses.
   */
  signersByFid(fid: number, opts: { pageSize?: number; pageToken?: string } = {}) {
    return this.get<SignersResponse>("/v1/signersByFid", {
      fid,
      pageSize: opts.pageSize ?? 100,
      pageToken: opts.pageToken,
    });
  }

  /** A single signer, when you already know the key. */
  signer(fid: number, signer: string) {
    return this.get<{ signer?: Signer }>("/v1/signer", { fid, signer });
  }

  /** Signers registered the old way, via an Optimism transaction to the KeyRegistry. */
  onChainSignersByFid(fid: number) {
    return this.get<{ events: unknown[] }>("/v1/onChainSignersByFid", { fid });
  }

  /** How much storage this FID has rented, and how much of it is used. */
  storageLimitsByFid(fid: number) {
    return this.get<{ limits: { storeType: string; limit: number; used: number }[] }>(
      "/v1/storageLimitsByFid",
      { fid },
    );
  }

  /**
   * Submit a signed message. A read node accepts writes: it validates, gossips the
   * message to validators on the `mempool` topic, and keeps nothing of its own.
   * The body is a serialized protobuf, not JSON.
   */
  async submitMessage(messageBytes: Uint8Array): Promise<Message> {
    const url = new URL("/v1/submitMessage", this.baseUrl);
    // slice() copies into a buffer that starts at offset 0 and is exactly this
    // message's length, so .buffer is a plain ArrayBuffer fetch will accept —
    // a subarray view would otherwise send surrounding bytes.
    const body = messageBytes.slice().buffer as ArrayBuffer;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new SnapchainError(
        `submitMessage rejected: ${res.status} ${body.slice(0, 400)}`,
        res.status,
        url.toString(),
      );
    }
    return (await res.json()) as Message;
  }
}

/** Profile fields, flattened from the separate UserData messages the node returns. */
export type Profile = {
  fid: number;
  username?: string;
  displayName?: string;
  bio?: string;
  pfpUrl?: string;
};

const USER_DATA_FIELDS: Record<string, keyof Profile> = {
  USER_DATA_TYPE_PFP: "pfpUrl",
  USER_DATA_TYPE_DISPLAY: "displayName",
  USER_DATA_TYPE_BIO: "bio",
  USER_DATA_TYPE_USERNAME: "username",
};

export async function getProfile(node: Snapchain, fid: number): Promise<Profile> {
  const profile: Profile = { fid };
  try {
    const { messages } = await node.userDataByFid(fid);
    for (const m of messages) {
      const body = m.data.userDataBody;
      if (!body) continue;
      const field = USER_DATA_FIELDS[body.type];
      if (field) (profile as Record<string, unknown>)[field] = body.value;
    }
  } catch {
    // A FID with no profile messages is normal — a freshly registered account has
    // none until it sets them. Return the bare FID rather than failing the feed.
  }
  return profile;
}

/** Farcaster timestamps are seconds since 2021-01-01, not since the Unix epoch. */
export function toDate(farcasterTimestamp: number): Date {
  const unixMs = fromFarcasterTime(farcasterTimestamp);
  if (unixMs.isErr()) throw unixMs.error;
  return new Date(unixMs.value);
}

/** FIDs this account follows, resolved from LinkAdd messages. */
export async function getFollowing(node: Snapchain, fid: number, max = 500): Promise<number[]> {
  const fids: number[] = [];
  let pageToken: string | undefined;
  do {
    const page = await node.linksByFid(fid, "follow", { pageSize: 100, pageToken });
    for (const m of page.messages) {
      const target = m.data.linkBody?.targetFid;
      if (target) fids.push(target);
    }
    pageToken = page.nextPageToken || undefined;
  } while (pageToken && fids.length < max);
  return fids.slice(0, max);
}

/**
 * A reverse-chronological home feed.
 *
 * Worth being honest about what this is: Snapchain has no "feed" primitive. A feed
 * is something a client constructs. This fans out across who you follow, takes
 * their recent casts, and merges by timestamp — which is the simplest thing that
 * works, and also why every client's feed looks different.
 */
export async function getHomeFeed(
  node: Snapchain,
  fid: number,
  opts: { limit?: number; perAuthor?: number; concurrency?: number } = {},
): Promise<Message[]> {
  const { limit = 50, perAuthor = 10, concurrency = 8 } = opts;

  const following = await getFollowing(node, fid);
  // Include your own casts, the way most clients do.
  const authors = [fid, ...following];

  const collected: Message[] = [];
  for (let i = 0; i < authors.length; i += concurrency) {
    const batch = authors.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((author) => node.castsByFid(author, { pageSize: perAuthor })),
    );
    for (const r of results) {
      // One unreachable author should not take down the whole feed.
      if (r.status === "fulfilled") collected.push(...r.value.messages);
    }
  }

  return collected
    .filter((m) => m.data.castAddBody)
    .sort((a, b) => b.data.timestamp - a.data.timestamp)
    .slice(0, limit);
}
