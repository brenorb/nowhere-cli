# Long-Form Builder Interface

The `create` command can now build Nowhere sites without a JSON file.

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

## Guardrails

- Use either `--input <path>` or long-form flags, not both.
- Use either `--description` or `--description-file`, not both.
- Use either `--svg` or `--svg-file`, not both.
- `--item` only works with `create store`.
- `--svg` and `--svg-file` only work with `create art`.
