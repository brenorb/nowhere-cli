---
name: verify-nowhere-forum-moderation
description: Check scoped moderation settings, bounded follow graph expansion, and banned-word filtering when changing Nowhere forum listings.
---

# Verify forum moderation

Moderated listings expand the owner's follow graph to the configured depth and remove content from excluded authors or with banned words. The access-check command reports author membership independently of content text.

Use Java 11 or later with `TLA2TOOLS` pointing to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
skill=.cursor/skills/verify-nowhere-forum-moderation
sh scripts/check-cli-state-machine.sh "$skill/Moderation.tla"
node --import tsx "$skill/references/check-moderation.mjs"
pnpm exec vitest run tests/e2e/live-commands.test.ts -t 'forum moderation commands|forum torrent replies'
```

## Coverage

`src/lib/forum-moderation.ts` is identical at main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`.

| Transition | Source |
| --- | --- |
| Read the configured depth, banned words and profile relays for a scope | `depthTagForScope`, `getForumModerationConfig` |
| Reuse fetched or in-flight lists, otherwise fetch and select latest list per author | `ensureFollowLists` |
| Expand the graph by depth, skip known nodes, stop at exhausted frontier | `buildForumWotSet` |
| Filter moderated results and report author access | `passesForumModeration`, `checkForumWotAccess`, moderated forum listings in `src/cli.ts` |

The model bounds four authors and three graph levels, with a cycle back to the owner. It uses a fixed follow graph and a Boolean result for case-insensitive text matching. Cached and failed fetches can change the graph that the CLI observes. The model assumes a resolved graph and leaves cache lifetime and relay selection outside the invariant.

TLC checked `ShownObeysModeration` and `GraphDepthBound` in 128 states. `Moderation-mutant.cfg` skips banned-word filtering. The local fixture exercises the production depth-zero and filter predicates. In a disposable checkout, make `passesForumModeration` return true after the author check and rerun the fixture. It rejects the mutation for a mixed-case banned word. Two source tests on a loopback relay passed for moderated listings and torrent replies. Rerun these checks and update the reviewed refs if changing the moderation rules.
