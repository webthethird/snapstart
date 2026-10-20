# snapstart

Run your own Farcaster read node and a client that talks to it, in three commands.

```
./snapstart provision      # (0) furnish the compute
./snapstart node up        # (1) start a Snapchain read node
./snapstart client create  # (2) issue an app key and launch the client
```

The node runs on infrastructure you own and needs **no API keys from anyone** — no
RPC endpoint, no hosted data provider, no signup. Once it is running it holds no
credentials at all.

The one credential in the picture is a **cloud API key**, and it belongs to the
provisioning CLI rather than to the node. `provision`, `status` and `destroy` all
talk to your cloud provider and need it; `node` and `client` do not. Keep it until
you have torn the server down, or delete it now and issue a fresh one when you do —
just don't delete it and assume cleanup will still work.

Default provider is AWS (`aws configure`). Hetzner is supported via
`SNAPSTART_PROVIDER=hetzner` and a `HETZNER_TOKEN` in `.env` — see below for why
it is not the default.

> **Status: work in progress.** Commands (1) and (2) are still being built. Nothing
> here should be considered stable yet.

## Why the numbers in this repo are measured, not quoted

Published Farcaster guides carry figures from whenever they were written, and
several are badly out of date. Everything here is read off a live system:

| Claim | Documented | Measured |
|---|---|---|
| FID registration + storage | ~$10 | **~$0.20** (`IdGateway.price()`, 2026-10-17) |
| Snapshot restore time | "up to 2 hours" | **13 h 22 m**, one restore timed end to end |
| Node's own restore ETA | ~3.5 h, from its progress bar | also wrong — it is ~4× optimistic |
| Node disk | 1.5 TB (repo README) / 2 TB (guides) | **1.5 TB peak, 558 GB settled** |

`npm run price` reads the current registration cost straight off Optimism. Don't
trust the table above either — run it.

### On disk: why this needs 2 TB, and why that surprised us

A read node's database settles around **550 GB**. The restore that produces it
peaks near **1,580 GB**. That gap is the single most important thing to know before
provisioning, and it isn't in any documentation.

Restoring runs a three-stage pipeline, per shard:

```
1. download   .rocks.snapshot/shard-N/chunk_*.bin     gzipped chunks
2. assemble   .rocks.snapshot/shard_N_snapshot.tar    concatenated from those chunks
3. extract    .rocks/                                 the actual RocksDB
```

Upstream deletes the staging directory with a single `remove_dir_all` that sits
**outside** the loop over shards (`src/storage/db/snapshot.rs`). So shard 1's
chunks and tar are still on disk while shard 2 downloads its own, and nothing is
reclaimed until every shard has finished.

Measured on a live restore of mainnet (5,689 chunks across 3 shards):

| | shard 1 |
|---|---|
| chunks | 2,671 files, 222 GB |
| assembled tar | 260 GB |
| extracted into the database | 260 GB |
| **still on disk when shard 2 began** | **482 GB of staging** |

### Why AWS is the default

**Hetzner Cloud caps new accounts at 1024 GB of volume storage.** Verified by
probe: a resize to 1030 GB is refused with `resource_limit_exceeded`. That is not
enough to complete an unmodified restore, so a brand-new Hetzner account cannot
follow this tutorial to the end — which is why the default provider is AWS, where
the root volume can simply be 2 TB.

Hetzner is roughly a third the price and remains fully supported once your account's
quota has been raised:

```
SNAPSTART_PROVIDER=hetzner ./snapstart provision
```

| | AWS (default) | Hetzner |
|---|---|---|
| Instance | m5.xlarge, 4 vCPU / 16 GB | cx43, 8 vCPU / 16 GB |
| Disk | 2048 GB gp3 root volume | 1024 GB attached volume |
| Cost | ~$0.41/hr, ~$9.85/day | ~€0.14/hr, ~€3.29/day |
| New account can finish? | yes | **no — quota** |

Both bill hourly. A tester runs a node for a day or two and destroys it, so the
real number is tens of dollars, not hundreds a month. `./snapstart destroy` verifies
the resources are actually gone before it discards local state.

## Safety

This client asks for a **custody seed phrase** in order to issue itself an app key.
That is a genuinely dangerous thing to type into software.

- Use a **throwaway test account**, never one you care about. Registering one costs
  about twenty cents (see `scripts/register-fid.ts`).
- Only paste a seed phrase into software whose source you have read, from people you
  have reason to trust. That includes this repository.
- The phrase is used **once**, locally, to authorize an app key, and is never sent
  anywhere and never copied to the server. The running client only ever holds the
  app key — which is scoped, expiring, and revocable.
- Prefer delegated signer authorization over seed phrase import wherever a flow
  supports it.

## Layout

```
snapstart              the CLI (provision / status / ssh / destroy)
scripts/app-key.ts     gasless app key issuance (FIP-272)
scripts/price.ts       live registration cost from Optimism
scripts/register-fid.ts  register a throwaway test account
```

## License

MIT.
