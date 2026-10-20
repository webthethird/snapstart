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
import { bytesToHex, decodeAbiParameters, hexToBytes } from "viem";
import { Snapchain, getProfile, type Message, type Signer } from "./snapchain.js";

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

/**
 * Metadata arrives base64-encoded, unlike the hex used everywhere else in this
 * API. Decoding it as hex silently yields nothing and every cast then reports as
 * an unknown client — which looks like "attribution doesn't work" rather than a
 * bug.
 */
function metadataToBytes(metadata: string): Uint8Array | undefined {
  try {
    if (metadata.startsWith("0x")) return hexToBytes(metadata as `0x${string}`);
    return new Uint8Array(Buffer.from(metadata, "base64"));
  } catch {
    return undefined;
  }
}

/**
 * Pull requestFid out of a metadata blob.
 *
 * Tries the library's gasless decoder first, then falls back to decoding the raw
 * ABI — the encodings are identical, only the EIP-712 domain the signature covers
 * differs, and attribution does not care about the signature.
 */
function requestFidFromMetadata(metadata: string): number | undefined {
  const bytes = metadataToBytes(metadata);
  if (!bytes || bytes.length === 0) return undefined;

  // Verified against a live node: onchain and gasless registrations ABI-encode
  // the same SignedKeyRequestMetadata struct, so one decoder serves both. Only
  // the EIP-712 domain the signature covers differs, and attribution does not
  // check the signature.
  const gasless = decodeGaslessSignedKeyRequestMetadata(bytes);
  if (gasless.isOk()) return Number(gasless.value.requestFid);

  try {
    const [decoded] = decodeAbiParameters(SIGNED_KEY_REQUEST_METADATA, bytesToHex(bytes));
    return Number((decoded as { requestFid: bigint }).requestFid);
  } catch {
    // Pre-SignedKeyRequest keys, or metadata this client does not understand.
    return undefined;
  }
}

/** Gasless keys carry metadata directly; onchain ones nest it in the event. */
function metadataOf(signer: Signer): string | undefined {
  return signer.metadata ?? signer.onChainEvent?.signerEventBody?.metadata;
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
  /** authorFid -> (signer key -> who registered it) */
  private readonly byAuthor = new Map<number, Map<string, ClientInfo>>();
  private readonly nameCache = new Map<number, string | undefined>();

  constructor(private readonly node: Snapchain) {}

  private async nameOf(fid: number): Promise<string | undefined> {
    if (this.nameCache.has(fid)) return this.nameCache.get(fid);
    const profile = await getProfile(this.node, fid);
    const name = profile.username ?? profile.displayName;
    this.nameCache.set(fid, name);
    return name;
  }

  /**
   * One request per author, not per signer. `/v1/signersByFid` returns every key
   * an account has registered, so a feed of 50 casts from 20 authors costs 20
   * lookups rather than 50 — and most authors appear many times.
   */
  private async signersFor(authorFid: number): Promise<Map<string, ClientInfo>> {
    const cached = this.byAuthor.get(authorFid);
    if (cached) return cached;

    const map = new Map<string, ClientInfo>();
    try {
      const { signers } = await this.node.signersByFid(authorFid);
      for (const signer of signers) {
        // Gasless registrations expose `requestFid` directly on the signer and carry
        // no `metadata` at all; onchain ones ABI-encode it into the blob. Checking
        // only the blob silently dropped every gasless key to "unknown", which made
        // a client unable to recognise its own posts.
        const metadata = metadataOf(signer);
        const requestFid =
          signer.requestFid ?? (metadata ? requestFidFromMetadata(metadata) : undefined);

        // `source` is reported by the node, so there is nothing to infer.
        const source: AttributionSource =
          requestFid === undefined
            ? "unknown"
            : requestFid === authorFid
              ? "self"
              : signer.source === "SIGNER_SOURCE_ONCHAIN"
                ? "onchain"
                : "gasless";

        map.set(signer.key.toLowerCase(), { requestFid, source, name: undefined });
      }
    } catch {
      // Leave the map empty; every signer then resolves to unknown rather than
      // the feed failing.
    }
    this.byAuthor.set(authorFid, map);
    return map;
  }

  async resolve(authorFid: number, signer: string): Promise<ClientInfo> {
    const signers = await this.signersFor(authorFid);
    const hit = signers.get(signer.toLowerCase());
    if (!hit || hit.requestFid === undefined) return UNKNOWN_CLIENT;

    // Resolve the app's display name lazily — app FIDs repeat across every user
    // of that app, so this is almost always a cache hit.
    if (hit.name === undefined) hit.name = await this.nameOf(hit.requestFid);
    return hit;
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

  const wanted = needle.trim().toLowerCase();
  if (client.name !== undefined && client.name.toLowerCase() === wanted) return true;

  // `clientBreakdown` labels a client with no profile name as "fid:N". That label
  // is what a UI shows and hands back here, so it has to round-trip — otherwise
  // excluding such a client appears to work and silently does nothing.
  const asFid = /^fid:(\d+)$/.exec(wanted);
  return asFid !== null && client.requestFid === Number(asFid[1]);
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
