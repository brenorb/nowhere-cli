---
name: verify-nowhere-forum-chat
description: Check general, room, and private chat routes and display filters when changing Nowhere forum messages and room announcements.
---

# Verify forum chat routing and reads

General chat and room announcements use the forum key. Room chat derives its key from the room name and access code. Private chat targets a session key. Listings decrypt candidates, validate payloads and signatures, and filter by room or peer when applicable.

Use Java 11 or later with `TLA2TOOLS` pointing to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
skill=.cursor/skills/verify-nowhere-forum-chat
sh scripts/check-cli-state-machine.sh "$skill/Chat.tla"
pnpm exec vitest run tests/e2e/live-commands.test.ts -t 'forum commands publish posts|reuses a persisted anonymous session'
```

## Coverage

`src/lib/forum-live.ts` is identical at main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`.

| Transition | Source in `src/lib/forum-live.ts` |
| --- | --- |
| Resolve author and sign and encrypt to the selected forum, room or recipient session | `publishGeneralChatMessage`, `publishRoomChatMessage`, `publishPrivateChatMessage`, `deriveRoomKeypair` |
| Publish or filter room announcements | `publishRoomAnnouncement`, `listRoomAnnouncements` |
| Fetch, decrypt, validate and filter chat by selected room or peer | `listGeneralChatMessages`, `listRoomChatMessages`, `listPrivateChatMessages` |

The model covers one candidate and abstracts key correctness, payload shape, signature verification, and target selection as independent outcomes. A general read always meets the target predicate. The model omits relay fan-out, watch deduplication, moderation and message ordering.

TLC checked `ShownMatchesChannel` in 120 states. The mutant bypasses the target filter. In a disposable checkout, run `python3 "$skill/references/extend-chat-test.py"` and rerun the first forum test above. Removing the optional peer comparison from `listPrivateChatMessages` makes the other-author assertion fail. Restore both disposable files, rerun the tests and update the reviewed refs on changes.

Use pstack’s `/statechart` to inspect the shortest path for a failing rule or visualize the checked flow. When the source changes, update the reviewed revision after rechecking the model and source fixture.
