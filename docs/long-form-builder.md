# Long-Form Builder Interface

The `create` command builds Nowhere sites without a JSON file. Pass `-i` or `--interactive` for prompts corresponding to the fields in the Hosted Nowhere builders.

## Interactive mode

Interactive mode works in two forms:

```bash
pnpm cli create drop -i --json
pnpm cli create --interactive --json
```

Behavior:

- `create <tool> -i` prompts only for the missing fields for that tool.
- `create -i` asks which tool you want first, then prompts for that tool's fields.
- Passed flags win. `--name`, `--description`, `--pubkey`, `--item`, `--svg`, and message `--title` prefill the session.
- A matching `--tag KEY=VALUE` also skips the corresponding Hosted Nowhere field prompt.
- Prompts label required and optional fields and show the complete payload before confirmation and encoding.
- Extra top-level and Store-item tags remain available after the named builder fields.

Interactive mode is intentionally separate from `--input <path>`.

## Requirements by tool

| Tool | Required input |
| --- | --- |
| `store` | Site name, owner pubkey, and at least one item |
| `event` | Site name |
| `fundraiser` | Site name |
| `petition` | Site name and owner pubkey |
| `message` | Author name and either a body or title |
| `drop` | Site name and description |
| `art` | Site name and SVG markup |
| `forum` | Site name and owner pubkey |

Store, petition, and forum owner pubkeys can be inferred from `--sign-secret` or `--use-signer`. Pubkeys accept Nowhere base64url, hex, `npub`, and copied `nostr:npub...` values.

## Hosted builder fields

The interactive schema mirrors the original Hosted Nowhere create pages and writes their canonical codec tags. Besides the common name, description, image, and pubkey fields, it prompts for:

- `store`: items and item variants, currency and weight units, policies, contacts, Lightning/PayID/custom payments, checkout fields, free shipping, rates, discounts, delivery, and country restrictions.
- `event`: style and colour, organiser, start/end time, venue/address/stream, admission, RSVP, lineup, agenda, capacity, restrictions, additional images, and contacts.
- `fundraiser`: creator, currency, goal, deadline, tagline, budget/story details, FAQ, Lightning/custom tips, and contacts.
- `petition`: organiser, signature goal, deadline, tagline/context, decision makers, signer comments, country restrictions, signer field requirements, and contacts.
- `message`: body or title, Lightning/custom tips, and contacts.
- `drop`: name, content, optional author pubkey, and extra tags.
- `art`: SVG, attribution, and frame theme.
- `forum`: topics, identity/privacy modes, size limit, Web-of-Trust depths, banned words, sharing, salt, torrents, categories, and torrent rules.

The upstream Store format currently uses tag `j` for both additional contacts and PayID. If contacts already occupy `j`, the interactive CLI reports that PayID was skipped rather than silently overwriting the contacts.

## Common fields

Use these flags with any tool:

```bash
pnpm cli create drop \
  --name "July Release" \
  --description "Private pre-release drop for testers." \
  --tag t=release \
  --use-signer \
  --json
```

Available common flags:

- `--name <text>`
- `--title <text>` for `message` sites, as sugar for the message title tag
- `--description <text>`
- `--description-file <path>`
- `--image <url>`
- `--pubkey <pubkey>`
- `--tag <tag>`

Tag format:

- `--tag V` creates a boolean tag with no value
- `--tag t=release` creates a valued tag

## Store items

Stores accept repeatable `--item` specs:

```bash
pnpm cli create store \
  --name "Freedom Market" \
  --item 'name=Sticker Pack;price=7.5;tag=f' \
  --item 'name=Zine;price=12;description=Printed field notes.' \
  --sign-secret nsec1... \
  --json
```

Supported item fields:

- `name`
- `price`
- `description`
- `image`
- `tag`

Interactive Store creation also provides named prompts for digital and featured items, category, maximum quantity, variants, weight, buyer-field requirements, custom checkout text, and multiple images. These are stored as the same item tags used by the web builder.

Item tags use the same `KEY` or `KEY=VALUE` format as top-level tags:

- `tag=f`
- `tag=t=Limited run`

If you need a literal semicolon inside an item value, escape it as `\;`.

## Art SVG input

Art sites can read SVG from a flag or a file:

```bash
pnpm cli create art \
  --name "Stencil" \
  --svg-file ./art/stencil.svg \
  --json
```

Available art-specific flags:

- `--svg <svg>`
- `--svg-file <path>`

## Owner pubkey inference

For `store`, `petition`, and `forum`, the CLI will infer the required owner pubkey from `--sign-secret` or `--use-signer` when you omit `--pubkey`.

## Implementation reuse

Interactive mode is a prompt layer, not a second create implementation. It reuses the long-form payload builder, Store item/tag parsers, owner-pubkey inference, tool requirement validation, signing, encryption, and upstream codec encoding. The shared tool schema controls both requirements and prompt order; only prompt I/O and compact serializers for contacts, tips, and custom payments are interactive-specific.

## Guardrails

- Use either `--input <path>` or `--interactive`, not both.
- Use either `--input <path>` or long-form flags, not both.
- Use either `--description` or `--description-file`, not both.
- Use either `--svg` or `--svg-file`, not both.
- `--item` only works with `create store`.
- `--title` only works with `create message`.
- `--svg` and `--svg-file` only work with `create art`.
