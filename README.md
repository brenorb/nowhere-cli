# nowhere-cli

CLI counterpart for [5t34k/nowhere](https://github.com/5t34k/nowhere).

Current scope in this first slice:

- generate and inspect Nostr keys
- inspect Nowhere fragments and URLs
- sign fragments with an existing Nostr key
- encrypt and decrypt fragments with a password

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
```
