# Nowhere CLI tag reference

Nowhere tags are not just labels. They are the compact internal config format the website uses to encode optional fields, behavior, and verification settings into the fragment itself.

## Why tags exist

- The website UI usually asks for normal fields like `Title`, `Deadline`, `Payment methods`, or `Topics`, then writes the corresponding short tags behind the scenes.
- The CLI accepts the raw codec shape directly, so you see `tags` explicitly.
- If a tag is absent, the renderer usually falls back to a default or hides that feature entirely.
- Tag meanings are tool-specific. `t` is not a universal "topic" tag. For example, it means a message title on `message`, a tagline on `fundraiser` and `petition`, and a custom checkout text field on store items.

## CLI-injected defaults

The CLI already injects a few upstream-style defaults when you omit them:

- `store`: `{ "key": "k", "value": "1" }`
- `event`: `{ "key": "T", "value": "g" }`
- `forum`: `{ "key": "i", "value": "1" }`, `{ "key": "H", "value": "0" }`, `{ "key": "V", "value": null }`
- `art`: `{ "key": "T", "value": "g" }`

## Common patterns

- `G`, `I`, `j`: Nostr, email, and extra contact methods
- `V`: default verification phrase length
- `1`, `2`: custom relay lists where that tool supports advanced relay routing
- Boolean tags are represented as `{ "key": "X", "value": null }` in JSON and stored upstream without a value

## Create currencies

Interactive creation uses one shared currency list for stores, events, and fundraisers: `USD`, `EUR`, `GBP`, `JPY`, `CAD`, `AUD`, `CHF`, `CNY`, `BRL`, `MXN`, `BTC`, and `SATS`.

## Tool tag cheat sheet

### `event`

- `D` / `d`: start and end datetime
- `L` / `l`: venue name and address
- `O`: online or stream URL
- `b`: long description
- `$` / `K`: admission amount and currency
- `r`: RSVP or tickets link/text
- `P`: lineup or speakers
- `A`: agenda or running order
- `q`, `R`, `v`: capacity, age restriction, dress code
- `T`, `C`: visual preset and accent color
- Without these tags, those sections simply do not render

### `message`

- `t`: headline shown above the body
- `l`: tip methods
- `G`, `I`, `j`: contact methods
- Without `t`, the page can still render with body-only content
- Without `l`, there is no tipping UI

### `fundraiser`

- `T`: creator or team name
- `$`, `g`, `h`: currency, goal amount, deadline
- `t`: tagline
- `b`: "what the money is for" or budget breakdown
- `Q`: FAQ
- `l`: donation methods
- `G`, `I`, `j`: contact methods

### `petition`

- `T`, `g`, `h`, `t`, `b`: organiser, signature goal, deadline, tagline, extra context
- `D`: decision makers
- `n/N e/E a/A b/B p/P z/Z u/U`: signer fields off/optional/required
- `R`: allow signer comments
- `c`: allowed countries
- `1`: custom signature relays
- These are real rules enforced by `petition sign`, not just display metadata

### `forum`

- `i`, `H`: identity mode and privacy mode
- `m`: post size limit
- `W`, `3`, `4`: Web-of-Trust depth for posts, replies, and chat
- `X`: banned words
- `O`: custom topics
- `S`, `9`: disable sharing and QR sharing
- `L`: enable salt-based namespace behavior
- `V`: enable voice toggle in the upstream model
- `b`, `q`, `F`, `5`, `h`: torrent feature, categories, fixed categories, torrent WoT depth, torrent rules
- `1`, `2`: custom relays

### `store`

- Store-level tags cover payment, checkout fields, shipping, pricing rules, restrictions, and footer content
- Payment: `l`, `j`, `5`
- Contact: `G`, `I`, `j`
- Buyer fields: `e/E`, `n/N`, `a/A`, `p/P`, `z/Z`
- Shipping and country rules: `F`, `J`, `L`, `s`, `S`, `h`, `H`, `c`, `x`
- Pricing and delivery: `m`, `B`, `X`, `D`
- Extra content: `b`, `Q`, `r`, `Y`
- Inventory and units: `k`, `$`, `w`
- Item-level tags add `d`, `f`, `g`, `q`, `v`, `W`, `t`
- These materially affect `store checkout quote`, `store checkout begin`, seller order verification, and what buyers can purchase

### `drop`

- Usually no special page-specific tags are needed beyond optional verification settings like `V`
- Most drops work fine with `tags: []`

### `art`

- `T`: frame or presentation theme
- `A`: attribution text
- Without `T`, the renderer defaults to gallery mode

## Why the website usually hides tags

The website builder is a form layer on top of the same schema. When you fill a field in the UI, the app writes the matching tags for you. The CLI exposes those tags directly for agents and scripts, while `create -i` provides named prompts for the same builder fields.
