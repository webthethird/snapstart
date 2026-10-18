/**
 * Which client posted this cast?
 *
 * A cast carries the Ed25519 key that signed it, and nothing else about its
 * origin. But that key was registered by somebody, and the registration records
 * the FID of the app that requested it. So:
 *
 *     cast.signer  →  the key's registration  →  requestFid  →  that app's profile
 *
 * Posting through Warpcast means Warpcast's own key signed your cast, and that key
 * names Warpcast as its requester. Posting through this client means a key you
 * issued yourself did, and names your own FID. That is the whole mechanism, and it
 * is what makes "hide everything from client X" possible at the protocol level
 * rather than as a favour from a platform.
 *
 * Nothing about this is in the published HTTP API docs; /v1/signer was found by
 * reading snapchain's http_server.rs.
 */
import { decodeGaslessSignedKeyRequestMetadata } from "@farcaster/core";
import { decodeAbiParameters, hexToBytes } from "viem";
import { Snapchain, getProfile, type Message } from "./snapchain.js";

/**
 * How a key came to be authorized. Worth surfacing in a UI: a `self` key means
 * nobody vouched for the client, which is a meaningfully different claim from
 * "Warpcast registered this".
 */
export type AttributionSource = "gasless" | "onchain" | "self" | "unknown";

export type ClientInfo = {
  /** FID of the app that requested the key, when it can be determined. */
  requestFid?: number;
  /** Human-readable name, resolved from that FID's profile. */
  name?: string;
  source: AttributionSource;
};

/** Both the gasless and the legacy onchain flows ABI-encode the same struct. */
const SIGNED_KEY_REQUEST_METADATA = [
  {
    type: "tuple",
    name: "SignedKeyRequestMetadata",
    components: [
      { name: "requestFid", type: "uint256" },
      { name: "requestSigner", type: "address" },
      { name: "signature", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
  },
] as const;

export const UNKNOWN_CLIENT: ClientInfo = { source: "unknown" };

function toHex(value: unknown): `0x${string}` | undefined {
  if (typeof value !== "string") return undefined;
  return (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;
}

/**
 * Pull requestFid out of a metadata blob.
 *
 * Tries the library's gasless decoder first, then falls back to decoding the raw
 * ABI — the encodings are identical, only the EIP-712 domain the signature covers
 * differs, and attribution does not care about the signature.
 */
function requestFidFromMetadata(metadataHex: `0x${string}`): number | undefined {
  const bytes = hexToBytes(metadataHex);

  const gasless = decodeGaslessSignedKeyRequestMetadata(bytes);
  if (gasless.isOk()) return Number(gasless.value.requestFid);

  try {
    const [decoded] = decodeAbiParameters(SIGNED_KEY_REQUEST_METADATA, metadataHex);
    return Number((decoded as { requestFid: bigint }).requestFid);
  } catch {
    // Pre-SignedKeyRequest keys, or metadata this client does not understand.
    return undefined;
  }
}

/**
 * The response shapes of /v1/signer and /v1/onChainSignersByFid are not documented,
 * so dig for a metadata field rather than assuming one path. Confirmed shapes
 * should replace this once a live node has been queried.
 */
function findMetadata(payload: unknown, depth = 0): `0x${string}` | undefined {
  if (!payload || typeof payload !== "object" || depth > 4) return undefined;
  const record = payload as Record<string, unknown>;

  for (const key of ["metadata", "signerMetadata", "keyMetadata"]) {
    const hex = toHex(record[key]);
    if (hex && hex.length > 2) return hex;
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findMetadata(item, depth + 1);
        if (found) return found;
      }
    } else if (value && typeof value === "object") {
      const found = findMetadata(value, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Resolves a signer to the client that registered it.
 *
 * Caching is not an optimisation here. A 50-cast feed can touch dozens of distinct
 * signers, and resolving each one naively costs two round trips — so an uncached
 * implementation spends a hundred requests rendering one screen. Signers repeat
 * heavily per author, and app FIDs repeat across every user of that app.
 */
export class ClientResolver {
  private readonly signerCache = new Map<string, ClientInfo>();
  private readonly nameCache = new Map<number, string | undefined>();

  constructor(private readonly node: Snapchain) {}

  private async nameOf(fid: number): Promise<string | undefined> {
    if (this.nameCache.has(fid)) return this.nameCache.get(fid);
    const profile = await getProfile(this.node, fid);
    const name = profile.username ?? profile.displayName;
    this.nameCache.set(fid, name);
    return name;
  }

  async resolve(authorFid: number, signer: string): Promise<ClientInfo> {
    const cached = this.signerCache.get(signer);
    if (cached) return cached;

    const info = await this.lookup(authorFid, signer);
    this.signerCache.set(signer, info);
    return info;
  }

  private async lookup(authorFid: number, signer: string): Promise<ClientInfo> {
    let requestFid: number | undefined;
    let source: AttributionSource = "unknown";

    // Gasless keys (FIP-272) are the current path.
    try {
      const metadata = findMetadata(await this.node.signer(authorFid, signer));
      if (metadata) {
        requestFid = requestFidFromMetadata(metadata);
        if (requestFid !== undefined) source = "gasless";
      }
    } catch {
      // Fall through to the onchain path.
    }

    // Keys registered the old way, by a transaction to the KeyRegistry on Optimism.
    // Still common: clients that predate FIP-272 register this way, so casts from
    // them resolve here or not at all.
    if (requestFid === undefined) {
      try {
        const metadata = findMetadata(await this.node.onChainSignersByFid(authorFid));
        if (metadata) {
          requestFid = requestFidFromMetadata(metadata);
          if (requestFid !== undefined) source = "onchain";
        }
      } catch {
        // Genuinely unattributable.
      }
    }

    if (requestFid === undefined) return UNKNOWN_CLIENT;

    // A key an account issued to itself. No third-party app is involved — someone
    // ran their own script or their own client, which is exactly what our test
    // account does, so expect to see this on our own casts.
    if (requestFid === authorFid) {
      return { requestFid, source: "self", name: await this.nameOf(requestFid) };
    }

    return { requestFid, source, name: await this.nameOf(requestFid) };
  }
}

export type AttributedCast = Message & { client: ClientInfo };

/** Annotate a feed with its originating clients, resolving each signer once. */
export async function attribute(
  node: Snapchain,
  casts: Message[],
  resolver = new ClientResolver(node),
): Promise<AttributedCast[]> {
  const out: AttributedCast[] = [];
  for (const cast of casts) {
    let client = UNKNOWN_CLIENT;
    try {
      client = await resolver.resolve(cast.data.fid, cast.signer);
    } catch {
      // An unresolvable signer must never remove a cast from the feed. Silently
      // dropping posts because a lookup failed is a bug that looks like a feature.
    }
    out.push({ ...cast, client });
  }
  return out;
}

export type ClientFilter = {
  /** Only these clients. Matched case-insensitively against name, or by FID. */
  include?: (string | number)[];
  /** Everything except these. Applied after `include`. */
  exclude?: (string | number)[];
  /** Whether casts whose client could not be determined survive an `include`. */
  keepUnknown?: boolean;
};

function matches(client: ClientInfo, needle: string | number): boolean {
  if (typeof needle === "number") return client.requestFid === needle;
  const name = client.name?.toLowerCase();
  return name !== undefined && name === needle.toLowerCase();
}

/**
 * Include or exclude casts by the client that posted them.
 *
 * `exclude` always wins over `include`, which is the behaviour people expect from
 * a blocklist: naming something you want gone should remove it, regardless.
 */
export function filterByClient(
  casts: AttributedCast[],
  filter: ClientFilter,
): AttributedCast[] {
  const { include, exclude, keepUnknown = false } = filter;

  return casts.filter((cast) => {
    if (exclude?.some((needle) => matches(cast.client, needle))) return false;
    if (!include || include.length === 0) return true;
    if (cast.client.source === "unknown") return keepUnknown;
    return include.some((needle) => matches(cast.client, needle));
  });
}

/** Count casts per client. Useful for showing someone what is actually in their feed. */
export function clientBreakdown(casts: AttributedCast[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cast of casts) {
    const label =
      cast.client.name ??
      (cast.client.requestFid !== undefined
        ? `fid:${cast.client.requestFid}`
        : "unknown client");
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]));
}
