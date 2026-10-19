/**
 * Posting, following and reacting — with confirmation that it actually landed.
 *
 * Every write here is submitted and then read back. That is not belt-and-braces;
 * it is the only way to know. A read node returns 200 once a message is
 * well-formed and handed to the gossip layer, and discards what happens next:
 * `gossip_message` in mempool.rs returns no Result, and the HTTP reply is
 * computed before it runs. A node with no peers logs `InsufficientPeers` and
 * drops the message, still returning 200.
 *
 * So "did my cast land" is answered by fetching it back by hash, never by the
 * status code. The hash is deterministic and known before submission.
 */
import {
  FarcasterNetwork,
  Message,
  NobleEd25519Signer,
  ReactionType,
  makeCastAdd,
  makeLinkAdd,
  makeLinkRemove,
  makeReactionAdd,
  makeReactionRemove,
} from "@farcaster/core";
import { Snapchain, SnapchainError } from "./snapchain.js";

/** Block interval measured at the tip: 1.01s. 20s is ~20 blocks of margin. */
const CONFIRM_TIMEOUT_MS = 20_000;
const CONFIRM_INTERVAL_MS = 1_000;

export type Confirmed<T> = { hash: string; confirmed: boolean; elapsedMs: number; value?: T };

export class WriteError extends Error {}

export class Client {
  private readonly signer: NobleEd25519Signer;

  constructor(
    private readonly node: Snapchain,
    private readonly fid: number,
    appKeyPrivate: Uint8Array,
    private readonly network: FarcasterNetwork = FarcasterNetwork.MAINNET,
  ) {
    this.signer = new NobleEd25519Signer(appKeyPrivate);
  }

  private get dataOptions() {
    return { fid: this.fid, network: this.network };
  }

  /**
   * Submit a signed message, then poll until the node reports it.
   *
   * `check` is what distinguishes success from a silently dropped write. If it
   * never returns true we report `confirmed: false` rather than pretending.
   */
  private async submitAndConfirm<T>(
    message: Message,
    check: (hash: string) => Promise<T | undefined>,
  ): Promise<Confirmed<T>> {
    const hash = `0x${Buffer.from(message.hash).toString("hex")}`;
    const started = Date.now();

    await this.node.submitMessage(Message.encode(message).finish());

    const deadline = started + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, CONFIRM_INTERVAL_MS));
      try {
        const found = await check(hash);
        if (found !== undefined) {
          return { hash, confirmed: true, elapsedMs: Date.now() - started, value: found };
        }
      } catch (err) {
        // A read failure mid-poll is not a write failure. Keep trying until the
        // deadline; only then do we admit we cannot confirm it.
        if (!(err instanceof SnapchainError)) throw err;
      }
    }
    return { hash, confirmed: false, elapsedMs: Date.now() - started };
  }

  /** Post a cast. `parent` makes it a reply. */
  async cast(text: string, opts: { parent?: { fid: number; hash: string } } = {}) {
    const result = await makeCastAdd(
      {
        text,
        embeds: [],
        embedsDeprecated: [],
        mentions: [],
        mentionsPositions: [],
        type: 0,
        ...(opts.parent
          ? { parentCastId: { fid: opts.parent.fid, hash: hexToBytes(opts.parent.hash) } }
          : {}),
      },
      this.dataOptions,
      this.signer,
    );
    if (result.isErr()) throw new WriteError(result.error.message);

    return this.submitAndConfirm(result.value, async (hash) => {
      const cast = await this.node.castById(this.fid, hash);
      return cast?.hash ? cast : undefined;
    });
  }

  /** Follow (LINK_ADD of type "follow"). Following costs storage — it is a message. */
  async follow(targetFid: number) {
    const result = await makeLinkAdd({ type: "follow", targetFid }, this.dataOptions, this.signer);
    if (result.isErr()) throw new WriteError(result.error.message);
    return this.submitAndConfirm(result.value, async () => {
      const { messages } = await this.node.linksByFid(this.fid, "follow", { pageSize: 100 });
      return messages.some((m) => m.data.linkBody?.targetFid === targetFid) ? true : undefined;
    });
  }

  async unfollow(targetFid: number) {
    const result = await makeLinkRemove({ type: "follow", targetFid }, this.dataOptions, this.signer);
    if (result.isErr()) throw new WriteError(result.error.message);
    return this.submitAndConfirm(result.value, async () => {
      const { messages } = await this.node.linksByFid(this.fid, "follow", { pageSize: 100 });
      return messages.some((m) => m.data.linkBody?.targetFid === targetFid) ? undefined : true;
    });
  }

  /** Like or recast a cast. */
  async react(
    target: { fid: number; hash: string },
    kind: "like" | "recast" = "like",
    opts: { remove?: boolean } = {},
  ) {
    const body = {
      type: kind === "like" ? ReactionType.LIKE : ReactionType.RECAST,
      targetCastId: { fid: target.fid, hash: hexToBytes(target.hash) },
    };
    const result = opts.remove
      ? await makeReactionRemove(body, this.dataOptions, this.signer)
      : await makeReactionAdd(body, this.dataOptions, this.signer);
    if (result.isErr()) throw new WriteError(result.error.message);

    return this.submitAndConfirm(result.value, async () => {
      const { messages } = await this.node.reactionsByCast(target.fid, target.hash);
      const mine = messages.some((m) => m.data.fid === this.fid);
      return opts.remove ? (mine ? undefined : true) : mine ? true : undefined;
    });
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return new Uint8Array(Buffer.from(clean, "hex"));
}
