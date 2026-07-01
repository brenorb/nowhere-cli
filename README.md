# nowhere-cli

CLI counterpart for [5t34k/nowhere](https://github.com/5t34k/nowhere).

Current scope in this first slice:

- generate and inspect Nostr keys
- inspect Nowhere fragments and URLs
- sign fragments with an existing Nostr key
- encrypt and decrypt fragments with a password
- persist a remote NIP-46 signer session and reuse it across create, sign, update, and owner-management flows
- create all eight Nowhere site types from structured JSON
- import, patch, and republish existing sites
- relay-backed runtime modules for store orders/status, petition signatures, and forum activity
- relay-backed CLI commands for store management, petition signing/owner review, and full forum activity management
- forum torrent authoring from real `.torrent` files, including duplicate preflight checks and publish-time normalization
- store checkout orchestration, fundraiser donation helpers, and message tip helpers, including Lightning invoice flows
- forum WoT and banned-word moderation checks for CLI-safe listing/filtering flows

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
pnpm cli signer connect --bunker 'bunker://...' --json
pnpm cli create store --input ./store.json --use-signer --json
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
pnpm cli forum posts 'https://hostednowhere.com/s#...' --moderated --profile-relay wss://relay.example.com --json
pnpm cli forum wot check 'https://hostednowhere.com/s#...' --scope post --author npub1... --json
pnpm cli store checkout quote 'https://hostednowhere.com/s#...' --cart ./cart.json --buyer-country US --json
pnpm cli store checkout begin 'https://hostednowhere.com/s#...' --cart ./cart.json --buyer ./buyer.json --method payid --json
pnpm cli fundraiser donate methods 'https://hostednowhere.com/s#...' --json
pnpm cli fundraiser donate invoice 'https://hostednowhere.com/s#...' --sats 5000 --json
pnpm cli message tip methods 'https://hostednowhere.com/s#...' --json
pnpm cli message tip invoice 'https://hostednowhere.com/s#...' --sats 2100 --json
```

## Builder Input

`create <tool>` accepts the upstream codec shape directly as JSON.

- Use `pubkey` as a Nowhere base64url pubkey, an `npub`, or a 64-char hex pubkey.
- Use tag objects like `{ "key": "V", "value": null }` for boolean tags that the web app stores without a value.
- `update` imports an existing site, merges the patch object, then re-encodes it through the upstream codec.

### Understanding tags

Nowhere tags are the compact internal config format behind the website UI. The CLI exposes them directly because it accepts the upstream codec shape, while the website usually collects the same information through normal form fields and writes the tags for you.

For the full per-tool tag mapping, CLI-injected defaults, and the explanation of which tags change rendering versus runtime behavior, see [docs/tags.md](docs/tags.md).

## Relay Runtimes

The CLI now includes upstream-compatible runtime modules for the parts of Nowhere that use Nostr relays after site creation:

- `src/lib/store-live.ts` publishes encrypted store orders, fetches seller-visible orders, fetches specific orders by `d` tag, verifies receipts/events/orders against store rules, publishes inventory/status updates, and reads the current status state.
- `src/lib/store-checkout.ts` computes website-style checkout quotes from real store data, resolves required buyer fields and inventory gating, and begins Lightning or manual-payment checkout flows by publishing the order and returning the next-step payment artifact.
- `src/lib/petition-live.ts` publishes petition signatures with the same `kind`, `d` tag, PoW, and owner-only decryption flow as the website.
- `src/lib/forum-live.ts` publishes and reads forum posts, replies, torrent entries, torrent reply threads, salted forum namespaces, room announcements, room chat, private chat, and general chat messages.
- `src/lib/forum-moderation.ts` ports the forum Web-of-Trust and banned-word filtering rules so CLI agents can check author eligibility and request moderated listings that match the website's visibility rules.
- `src/lib/fundraiser-donate.ts` lists fundraiser donation methods from tag `l` and can mint Lightning invoices for donation amounts in sats.
- `src/lib/message-tips.ts` lists message tip methods from tag `l` and can mint Lightning invoices for reader tips in sats.

Those modules are covered with e2e tests against the local mock relay in `tests/support/mockRelay.ts`, and the command layer in `src/cli.ts` now wraps them for agent-facing automation.

## Relay Commands

The CLI now exposes the main relay-backed workflows directly:

- `store order`, `store receipt decrypt`, `store orders`, `store verify`, `store status publish`, `store status fetch`
- `store checkout quote`, `store checkout begin`
- `fundraiser donate methods`, `fundraiser donate invoice`
- `message tip methods`, `message tip invoice`
- `petition sign`, `petition count`, `petition signatures`
- `forum post`, `forum posts`, `forum reply`, `forum replies`, `forum torrent publish`, `forum torrent reply`, `forum torrent replies`, `forum torrents`, `forum room announce`, `forum room announcements`, `forum room send`, `forum room list`, `forum chat send`, `forum chat list`, `forum private send`, `forum private list`, `forum wot check`
- `forum torrent parse` reads a real `.torrent` file and extracts the infohash, inferred title, file list, and deduplicated tracker set the same way the website does.
- `forum torrent check` runs the website-style submission preflight against a forum: torrent feature enabled via `b`, normalized category path, fixed-root enforcement via `F`/`q`, and duplicate detection by infohash then case-insensitive title.
- `forum torrent publish` now accepts either `--input <json>` for raw agent-authored payloads or `--torrent-file <path>` plus `--category`, with optional `--title`, `--description`, repeated `--tracker`, and repeated `--ref`.

Publish-style commands accept structured JSON via `--input <path>` or `--input -` from stdin. Relay overrides use repeated `--relay <url>` flags; if omitted, the CLI falls back to the relay tags embedded in the site where that flow supports it. Forum commands also accept `--salt <value>` anywhere the website derives an alternate salted forum keyspace.

Any runtime command that opens a store, petition, fundraiser, message, or forum now also accepts `--password <password>` so encrypted links behave the same way they do on the website: the CLI decrypts first, then runs the downstream order, checkout, signature, tip, donation, moderation, or forum flow against the decrypted site.

`signer connect`, `signer status`, and `signer disconnect` manage a persisted remote NIP-46 session under `XDG_CONFIG_HOME/nowhere-cli/active-signer.json`. Use `--use-signer` anywhere the website can reuse an existing signer instead of exporting an `nsec`: `sign`, `create`, `update`, `store receipt decrypt`, `store orders`, `store verify`, `store status publish`, `petition sign`, `petition signatures`, `forum post`, `forum reply`, `forum torrent publish`, `forum torrent reply`, `forum chat send`, `forum private send`, `forum room announce`, and `forum room send`.

Encrypted fragments are accepted as normal positional arguments even when the base64url payload begins with `-`, so agents do not need to prepend `--` manually when opening encrypted store, petition, fundraiser, message, or forum links.

`store order` accepts the same human-facing totals the website computes in major units and converts them to the wire-format cent fields before publishing. `store orders` also accepts repeated `--order-id <id>` values for targeted lookups, and `store verify` can validate a receipt, encrypted order event, or plaintext order JSON against the store's shipping, discount, and historical-rate rules.

`store checkout quote` mirrors the website's preflight: it calculates subtotal, shipping, discount, total, buyer-field requirements, allowed/excluded countries, payment-method availability, and inventory gating from the current encrypted status payload when tag `k` is enabled. `store checkout begin` then publishes the order and returns either a Lightning invoice or manual payment instructions, depending on the chosen method.

`store orders` now also accepts `--csv` for the same export-style workflow the manage dashboard exposes.

Anonymous forum posts, replies, torrent submissions, room flows, and general chat now reuse one persisted forum session secret under `XDG_CONFIG_HOME/nowhere-cli/forum-session.json` by default, which matches the website's stable in-session anonymous identity behavior. Set `NOWHERE_FORUM_SESSION_SECRET` or pass `--session-secret` where supported to override that identity explicitly.

`forum chat send` accepts `--session-secret` to override the advertised stable session pubkey that the website uses for private chat routing. Without it, the CLI advertises the persisted forum session automatically. `forum private send` targets a discovered session pubkey directly, and `forum private list` decrypts the inbox for either the persisted session or an explicit `--session-secret`.

`forum posts`, `forum replies`, `forum torrents`, `forum chat list`, and `forum room list` now accept `--moderated` so agents can ask for the same WoT/banned-word filtered view the website renders. `forum wot check` exposes the underlying author-eligibility decision directly for the `post`, `reply`, `chat`, and `torrent` scopes.

`petition sign` now enforces the petition's own required-field tags and country restrictions before it spends time encrypting, computing proof-of-work, and publishing.

`petition signatures` now also accepts `--csv` for owner-side signature export.

`fundraiser donate methods` exposes the parsed donation handles from the fundraiser's `l` tag, and `fundraiser donate invoice` can turn the Lightning handle into a live invoice for a sats amount.

`message tip methods` exposes the parsed tip handles from the message's `l` tag, and `message tip invoice` can turn the Lightning handle into a live invoice for a sats amount.
