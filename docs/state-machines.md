# Nowhere CLI state machines

Reviewed `nowhere-cli` main at `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and the cited `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`. Both versions register 58 actions in `src/cli.ts`. The package exposes `nowhere` through `dist/cli.js`. `npx nowhere-cli` uses the same package entrypoint.

## Commands

| Actions | State and verification |
| --- | --- |
| `keygen`, `pubkey`, `inspect` | Key creation, key description and fragment decoding are single-invocation operations. Parser and secret source preflight are covered by [command dispatch](../.cursor/skills/verify-nowhere-command-dispatch/SKILL.md). |
| `signer connect`, `signer start`, `signer wait`, `signer status`, `signer disconnect` | Persist or restore an authorization session and run NIP-46 RPCs. [Signer skill](../.cursor/skills/verify-nowhere-signer/SKILL.md) · [Pairing chart](statecharts/signer.md) |
| `sign`, `verify`, `update`, `encrypt`, `decrypt` | Parse and resolve fragments, preserve signature/encryption ordering, and transform or verify the result. [Site protection skill](../.cursor/skills/verify-nowhere-site-protection/SKILL.md) · [Protection chart](statecharts/site-protection.md) |
| `create` | Normalize a supplied payload or run the interactive form and confirmation, then build a site. [Builder skill](../.cursor/skills/verify-nowhere-builder/SKILL.md) · [Interactive chart](statecharts/create-interactive.md) |
| `store order`, `store receipt decrypt`, `store orders`, `store verify`, `store status publish`, `store status fetch` | Create and read order records, compute verification totals and payment checks, and publish or fetch inventory status. [Store live skill](../.cursor/skills/verify-nowhere-store-live/SKILL.md) · [Seller orders chart](statecharts/seller-orders.md) |
| `store manage state`, `store manage status`, `store manage confirm`, `store manage unconfirm`, `store manage hide`, `store manage unhide`, `store manage note`, `store manage reconcile` | Read or mutate local order overlays and reconcile known IDs. [Bookkeeping skill](../.cursor/skills/verify-nowhere-store-bookkeeping/SKILL.md) |
| `store checkout quote`, `store checkout begin` | Check cart and inventory, resolve payment requirements, publish an order, and request an invoice where applicable. [Checkout skill](../.cursor/skills/verify-nowhere-checkout/SKILL.md) · [Checkout chart](statecharts/checkout.md) |
| `petition sign`, `petition count`, `petition signatures` | Validate and publish a petition signature, count by tag, or collect and decrypt owner-visible records. [Petition skill](../.cursor/skills/verify-nowhere-petition/SKILL.md) · [Signing chart](statecharts/petition-sign.md) |
| `fundraiser donate methods`, `fundraiser donate invoice`, `message tip methods`, `message tip invoice` | Select a payment method, enforce amount limits, and request a Lightning invoice. [Invoice skill](../.cursor/skills/verify-nowhere-invoice/SKILL.md) · [Invoice chart](statecharts/invoice.md) |
| `forum wot check` | Resolve the moderation scope and expand the owner's follow graph. [Moderation skill](../.cursor/skills/verify-nowhere-forum-moderation/SKILL.md) |
| `forum post`, `forum posts`, `forum reply`, `forum replies` | Enforce publication policy and resolve reply targets, decrypt and list events. [Posts skill](../.cursor/skills/verify-nowhere-forum-posts/SKILL.md) |
| `forum torrent parse`, `forum torrent check`, `forum torrent publish`, `forum torrent reply`, `forum torrent replies`, `forum torrents` | Parse metadata, enforce categories, reject a visible duplicate, publish and list. [Torrent skill](../.cursor/skills/verify-nowhere-forum-torrent/SKILL.md) |
| `forum chat send`, `forum chat list`, `forum private send`, `forum private list`, `forum room announce`, `forum room announcements`, `forum room send`, `forum room list` | Derive the forum, room or private session route, publish and filter received messages. [Chat skill](../.cursor/skills/verify-nowhere-forum-chat/SKILL.md) |
| `forum voice send`, `forum voice list` | Derive the voice signaling route and report validity of a received join proof. [Voice skill](../.cursor/skills/verify-nowhere-voice-signals/SKILL.md) |

All commands share [command preflight](../.cursor/skills/verify-nowhere-command-dispatch/SKILL.md). Forum publication and private listings can use a persisted [forum session](../.cursor/skills/verify-nowhere-forum-session/SKILL.md). Nine forum listings can switch to [watch mode](../.cursor/skills/verify-nowhere-forum-watch/SKILL.md), which deduplicates across polling rounds. [Forum watch chart](statecharts/forum-watch.md)

## Shared modules and development entrypoints

| Source | Behavior |
| --- | --- |
| `active-signer.ts`, `nostr-connect-client.ts`, `keys.ts` | Signer persistence, pairing and request lifecycle. Key conversion operates on the current invocation. |
| `builders.ts`, `create-field-prompts.ts`, `create-interactive.ts`, `create-long-form.ts`, `create-prompt-session.ts`, `create-tools.ts` | Tool selection and builder state, with form defaults and validation. |
| `cli-conventions.ts`, `io.ts`, `output.ts`, `csv-export.ts` | Preflight, input and output formatting. The output and CSV helpers format supplied values without retaining session state. |
| `config.ts`, `private-files.ts` | Resolve state directory and stage replacement files, used by signer, forum session and bookkeeping. |
| `fragments.ts`, `site-signature.ts`, `constants.ts` | Fragment and signature handling and shared constants. |
| `forum-live.ts`, `forum-session.ts`, `forum-moderation.ts`, `torrent-bencode.ts` | Forum publish, receive, and filtering paths above. The torrent parser advances through the input buffer during metadata extraction. |
| `relay.ts`, `network.ts` | Shared [relay publication and count handling](../.cursor/skills/verify-nowhere-relays/SKILL.md) and request deadlines. |
| `store-live.ts`, `store-checkout.ts`, `store-manage-state.ts` | Live order and inventory, checkout, and local order state. |
| `contacts.ts`, `custom-payments.ts`, `payment-methods.ts`, `tips.ts` | Structured value parsing, serialization and method selection. These process a single supplied value or tag set and return values to the builder or payment flows. |
| `fundraiser-donate.ts`, `message-tips.ts`, `lightning.ts`, `petition-live.ts` | Invoice and petition flows above. |
| `src/types/pako.d.ts` | Type declaration. |
| `package.json`, `tsup.config.ts`, `tests/e2e/packed-cli.ts` | Package build, prepack, prepublish gate and packed install. [Packaging skill](../.cursor/skills/verify-nowhere-package/SKILL.md) |
| `pnpm cli`, `lint`, `lint:fix`, `typecheck`, `test`, `check`, `test:e2e:packed` | Source dispatch, standard lint/typecheck/test commands, sequential prepublish checks, and the project-specific packed lifecycle. |

The models are bounded and source replays use temporary files, local relays, fake providers, or the packaged CLI. Review each skill's assumptions before applying an invariant to production behavior.
