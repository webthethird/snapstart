# snapstart

Run your own Farcaster read node and a client that talks to it, in three commands.

```
./snapstart provision      # (0) furnish the compute
./snapstart node up        # (1) start a Snapchain read node
./snapstart client create  # (2) issue an app key and launch the client
```

The node runs on infrastructure you own and needs **no API keys from anyone**. The
only credential involved is a cloud API token used once to create the server, which
you can delete the moment provisioning finishes.

> **Status: work in progress.** Commands (1) and (2) are still being built. Nothing
> here should be considered stable yet.

## Why the numbers in this repo are measured, not quoted

Published Farcaster guides carry figures from whenever they were written, and
several are badly out of date. Everything here is read off a live system:

| Claim | Documented | Measured |
|---|---|---|
| FID registration + storage | ~$10 | **~$0.20** (`IdGateway.price()`, 2026-10-17) |
| Node disk | 1.5 TB (README) / 2 TB (guides) | *in progress* |

`npm run price` reads the current registration cost straight off Optimism. Don't
trust the table above either — run it.

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
