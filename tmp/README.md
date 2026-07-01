# Sample Builder Inputs

These payloads are ready to use with the local CLI.

The fixtures are set up for the currently persisted remote signer session:

- `event`, `fundraiser`, `message`, `drop`, and `art` omit `pubkey`, so `--use-signer` can sign them with any active signer.
- `store`, `petition`, and `forum` require an owner `pubkey`, so they are prefilled with the current `pnpm cli signer status` `npub`.

Examples:

```bash
pnpm cli create event --input ./tmp/event.json --json
pnpm cli create fundraiser --input ./tmp/fundraiser.json --json
pnpm cli create message --input ./tmp/message.json --json
pnpm cli create drop --input ./tmp/drop.json --json
pnpm cli create art --input ./tmp/art.json --json
pnpm cli create store --input ./tmp/store.json --json
pnpm cli create petition --input ./tmp/petition.json --json
pnpm cli create forum --input ./tmp/forum.json --json
```

If you want to sign with the active remote signer, use:

```bash
pnpm cli create drop --input ./tmp/drop.json --use-signer --json
pnpm cli create store --input ./tmp/store.json --use-signer --json
```

If you want to sign with the throwaway key in `./tmp/test-key.json`, first replace any required `pubkey` fields in `store.json`, `petition.json`, and `forum.json`, then use:

```bash
pnpm cli create store --input ./tmp/store.json --sign-secret "$(jq -r .nsec ./tmp/test-key.json)" --json
```
