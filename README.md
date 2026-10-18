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

The one credential in the picture is a **cloud API token**, and it belongs to the
provisioning CLI rather than to the node. `provision`, `status` and `destroy` all
talk to your cloud provider and need it; `node` and `client` do not. Keep it until
you have torn the server down, or delete it now and issue a fresh one when you do —
just don't delete it and assume cleanup will still work.

> **Status: work in progress.** Commands (1) and (2) are still being built. Nothing
> here should be considered stable yet.

## Why the numbers in this repo are measured, not quoted

Published Farcaster guides carry figures from whenever they were written, and
several are badly out of date. Everything here is read off a live system:

| Claim | Documented | Measured |
|---|---|---|
| FID registration + storage | ~$10 | **~$0.20** (`IdGateway.price()`, 2026-10-17) |
| Snapshot restore time | "up to 2 hours" | ~3.5 h reported by the node itself |
| Node disk | 1.5 TB (repo README) / 2 TB (guides) | *measuring — but see below, 2 TB looks right* |

`npm run price` reads the current registration cost straight off Optimism. Don't
trust the table above either — run it.

### On disk: the 2 TB in the docs is probably right

An earlier version of this file argued 1 TB was enough, reasoning from the size of
the compressed download. That was wrong, and the reason is worth knowing before you
provision anything.

Restoring is a **three-stage pipeline**, and the stages overlap on disk:

```
1. download   .rocks.snapshot/shard-N/chunk_*.bin     2,671 files, 222 GB (shard 1)
2. assemble   .rocks.snapshot/shard_N_snapshot.tar    concatenated from those chunks
3. extract    .rocks/                                 the actual RocksDB
```

Shard 1's chunks are still on disk while its tar is being built, so peak usage is
a multiple of the final database size — and shard 1 is only 2,671 of 5,689 chunks.

**Hetzner Cloud caps new accounts at 1024 GB of volume storage.** Verified by probe:
a resize to 1030 GB is refused with `resource_limit_exceeded`. If the pipeline does
not clean up after each shard, a new Hetzner account cannot complete a restore
without requesting a quota increase first. That is a real barrier and this README
will say which it is once measured.

Until then: `node status` warns at 80% full, `./snapstart volume grow <GB>` resizes
online without destroying anything, and `SNAPSTART_VOLUME_GB=2048` provisions the
documented size if your account allows it.

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
