---
name: verify-nowhere-forum-posts
description: Check topic, reply target, size, and forum identity gates when changing Nowhere posts and replies.
---

# Verify forum post and reply publication

A post checks its topic and size. A reply resolves and decrypts the target post before checking the reply size. Both resolve an author allowed by the forum before signing, encrypting and publishing the event.

Use Java 11 or later with `TLA2TOOLS` pointing to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
skill=.cursor/skills/verify-nowhere-forum-posts
sh scripts/check-cli-state-machine.sh "$skill/Posts.tla"
pnpm exec vitest run tests/e2e/live-commands.test.ts -t 'forum commands publish posts|forum identity mode rules|reuses a persisted anonymous session'
```

## Coverage

`src/lib/forum-live.ts` is identical at main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`.

| Transition | Source in `src/lib/forum-live.ts` |
| --- | --- |
| Derive the forum, namespace and topic, and enforce the configured size | `createContext`, `requireAllowedForumTopic`, `enforceForumPostSizeLimit`, `enforceForumReplySizeLimit` |
| Resolve an allowed author, sign and publish the encrypted event | `resolveForumAuthor`, `resolveAuthor`, `publishForumPostFromInput`, `publishForumReplyFromInput` |
| Fetch and validate the parent post before replying or listing replies | `decryptPost`, `publishForumReplyFromInput`, `listForumReplies` |
| List candidates and decode posts or replies | `listForumPosts`, `listForumReplies` |

The model bounds one submission and three author policies. It abstracts correct topic or reply parent, size, signing and relay outcomes, and leaves decryption and listing moderation to source checks and the moderation skill.

TLC checked `PublishedMeetsPolicy` in 120 states. The mutant allows publication with a disallowed author mode. In a disposable checkout, bypass the signed-only guard in `resolveForumAuthor`. The loopback test for identity modes fails when a missing explicit identity is accepted. Three matching source tests passed in the restored code. Rerun the checks and update the reviewed refs when editing these gates.
