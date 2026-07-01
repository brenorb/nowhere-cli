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
- relay-backed CLI commands for store management, petition signing/owner review, and full forum activity management
- forum torrent authoring from real `.torrent` files, including duplicate preflight checks and publish-time normalization

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
pnpm cli store order 'https://hostednowhere.com/s#...' --input ./order.json --relay ws://127.0.0.1:7000 --json
pnpm cli petition sign 'https://hostednowhere.com/s#...' --input ./signature.json --secret nsec1... --json
pnpm cli forum post 'https://hostednowhere.com/s#...' --input ./post.json --secret nsec1... --json
pnpm cli forum torrent parse ./archive.torrent --json
pnpm cli forum torrent check 'https://hostednowhere.com/s#...' --torrent-file ./archive.torrent --category 'docs > manuals' --json
pnpm cli forum torrent publish 'https://hostednowhere.com/s#...' --torrent-file ./archive.torrent --category 'docs > manuals' --secret nsec1... --json
```

## Builder Input

`create <tool>` accepts the upstream codec shape directly as JSON.

- Use `pubkey` as a Nowhere base64url pubkey, an `npub`, or a 64-char hex pubkey.
- Use tag objects like `{ "key": "V", "value": null }` for boolean tags that the web app stores without a value.
- `update` imports an existing site, merges the patch object, then re-encodes it through the upstream codec.

## Relay Runtimes

The CLI now includes upstream-compatible runtime modules for the parts of Nowhere that use Nostr relays after site creation:

- `src/lib/store-live.ts` publishes encrypted store orders, fetches seller-visible orders, fetches specific orders by `d` tag, verifies receipts/events/orders against store rules, publishes inventory/status updates, and reads the current status state.
- `src/lib/petition-live.ts` publishes petition signatures with the same `kind`, `d` tag, PoW, and owner-only decryption flow as the website.
- `src/lib/forum-live.ts` publishes and reads forum posts, replies, torrent entries, torrent reply threads, salted forum namespaces, room announcements, room chat, private chat, and general chat messages.

Those modules are covered with e2e tests against the local mock relay in `tests/support/mockRelay.ts`, and the command layer in `src/cli.ts` now wraps them for agent-facing automation.

## Relay Commands

The CLI now exposes the main relay-backed workflows directly:

- `store order`, `store receipt decrypt`, `store orders`, `store verify`, `store status publish`, `store status fetch`
- `petition sign`, `petition count`, `petition signatures`
- `forum post`, `forum posts`, `forum reply`, `forum replies`, `forum torrent publish`, `forum torrent reply`, `forum torrent replies`, `forum torrents`, `forum room announce`, `forum room announcements`, `forum room send`, `forum room list`, `forum chat send`, `forum chat list`, `forum private send`, `forum private list`
- `forum torrent parse` reads a real `.torrent` file and extracts the infohash, inferred title, file list, and deduplicated tracker set the same way the website does.
- `forum torrent check` runs the website-style submission preflight against a forum: torrent feature enabled via `b`, normalized category path, fixed-root enforcement via `F`/`q`, and duplicate detection by infohash then case-insensitive title.
- `forum torrent publish` now accepts either `--input <json>` for raw agent-authored payloads or `--torrent-file <path>` plus `--category`, with optional `--title`, `--description`, repeated `--tracker`, and repeated `--ref`.

Publish-style commands accept structured JSON via `--input <path>` or `--input -` from stdin. Relay overrides use repeated `--relay <url>` flags; if omitted, the CLI falls back to the relay tags embedded in the site where that flow supports it. Forum commands also accept `--salt <value>` anywhere the website derives an alternate salted forum keyspace.

`store order` accepts the same human-facing totals the website computes in major units and converts them to the wire-format cent fields before publishing. `store orders` also accepts repeated `--order-id <id>` values for targeted lookups, and `store verify` can validate a receipt, encrypted order event, or plaintext order JSON against the store's shipping, discount, and historical-rate rules.

`forum chat send` accepts `--session-secret` to advertise the stable session pubkey that the website uses for private chat routing. `forum private send` targets a discovered session pubkey directly, and `forum private list` decrypts the inbox for a given session secret.

`petition sign` now enforces the petition's own required-field tags and country restrictions before it spends time encrypting, computing proof-of-work, and publishing.
