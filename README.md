# nowhere-cli

CLI counterpart for [5t34k/nowhere](https://github.com/5t34k/nowhere).

Current scope in this first slice:

- generate and inspect Nostr keys
- inspect Nowhere fragments and URLs
- sign fragments with an existing Nostr key
- encrypt and decrypt fragments with a password
- create all eight Nowhere site types from structured JSON
- import, patch, and republish existing sites
- relay-backed runtime modules for store orders/status, petition signatures, and forum activity

Commands currently optimized for agent use expose `--json` output.

## Development

```bash
pnpm install
pnpm test
pnpm build
```

## Examples

```bash
pnpm cli keygen --json
pnpm cli pubkey --secret nsec1...
pnpm cli inspect 'https://hostednowhere.com/s#...'
pnpm cli sign 'https://hostednowhere.com/s#...' --secret nsec1... --json
pnpm cli encrypt 'https://hostednowhere.com/s#...' --password 'correct horse battery staple'
pnpm cli decrypt 'https://hostednowhere.com/s#...' --password 'correct horse battery staple'
pnpm cli create petition --input ./petition.json --sign-secret nsec1... --encrypt-password 'opsec'
pnpm cli update 'https://hostednowhere.com/s#...' --patch ./patch.json --json
```

## Builder Input

`create <tool>` accepts the upstream codec shape directly as JSON.

- Use `pubkey` as a Nowhere base64url pubkey, an `npub`, or a 64-char hex pubkey.
- Use tag objects like `{ "key": "V", "value": null }` for boolean tags that the web app stores without a value.
- `update` imports an existing site, merges the patch object, then re-encodes it through the upstream codec.

## Relay Runtimes

The CLI now includes upstream-compatible runtime modules for the parts of Nowhere that use Nostr relays after site creation:

- `src/lib/store-live.ts` publishes encrypted store orders, fetches seller-visible orders, publishes inventory/status updates, and reads the current status state.
- `src/lib/petition-live.ts` publishes petition signatures with the same `kind`, `d` tag, PoW, and owner-only decryption flow as the website.
- `src/lib/forum-live.ts` publishes and reads forum posts, replies, torrent entries, and general chat messages.

Those modules are covered with e2e tests against the local mock relay in `tests/support/mockRelay.ts`. The next slice wires them into top-level CLI commands.
