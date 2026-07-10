# Create Command Fixtures

These payloads are ready to use with the local CLI.

The fixtures are set up for the currently persisted remote signer session:

- `event`, `fundraiser`, `message`, `drop`, and `art` omit `pubkey`, so `--use-signer` can sign them with any active signer.
- `store`, `petition`, and `forum` require an owner `pubkey`, so they are prefilled with the current `pnpm cli signer status` `npub`.

Examples:

```bash
pnpm cli create event --input ./tests/fixtures/create/event.json --json
pnpm cli create fundraiser --input ./tests/fixtures/create/fundraiser.json --json
pnpm cli create message --input ./tests/fixtures/create/message.json --json
pnpm cli create drop --input ./tests/fixtures/create/drop.json --json
pnpm cli create art --input ./tests/fixtures/create/art.json --json
pnpm cli create store --input ./tests/fixtures/create/store.json --json
pnpm cli create petition --input ./tests/fixtures/create/petition.json --json
pnpm cli create forum --input ./tests/fixtures/create/forum.json --json
```

If you want to sign with the active remote signer, use:

```bash
pnpm cli create drop --input ./tests/fixtures/create/drop.json --use-signer --json
pnpm cli create store --input ./tests/fixtures/create/store.json --use-signer --json
```

If you want to sign with the throwaway key in `./tests/fixtures/create/test-key.json`, first replace any required `pubkey` fields in `store.json`, `petition.json`, and `forum.json`, then use:

```bash
pnpm cli create store --input ./tests/fixtures/create/store.json --sign-secret "$(jq -r .nsec ./tests/fixtures/create/test-key.json)" --json
```
