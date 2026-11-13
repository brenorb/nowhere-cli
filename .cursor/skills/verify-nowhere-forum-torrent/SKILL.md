---
name: verify-nowhere-forum-torrent
description: Check torrent parsing, forum submission policy, duplicate reporting and publication when changing Nowhere forum torrent commands.
---

# Verify forum torrent submission

The CLI extracts torrent metadata, validates forum policy, and fetches prior listings to check for matching infohashes and titles. A check reports the match. A publish rejects a match before signing or sending.

Use Java 11 or later with `TLA2TOOLS` pointing to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
skill=.cursor/skills/verify-nowhere-forum-torrent
sh scripts/check-cli-state-machine.sh "$skill/Torrent.tla"
pnpm exec vitest run tests/e2e/live-commands.test.ts -t 'forum commands publish posts|forum torrent replies'
```

## Coverage

The torrent parser and publication module are identical at main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`.

| Transition | Source |
| --- | --- |
| Parse bencode, identify raw info bytes, hash, normalize metadata | `torrent-bencode.ts`, `parseTorrentFile`, `parseValue`, `extractInfoBytes`; `forum-live.ts`, `buildTorrentDataFromParsedTorrent` |
| Enforce enabled settings, required title and configured categories | `forum-live.ts`, `checkForumTorrentSubmission` |
| Fetch, decrypt and verify existing torrent metadata and choose a duplicate reason | `forum-live.ts`, `listForumTorrents`, `checkForumTorrentSubmission` |
| Sign and publish or return the check result | `forum-live.ts`, `publishForumTorrentFromInput`; `cli.ts`, forum torrent check and publish |
| Resolve a torrent event and publish or list replies | `forum-live.ts`, `publishForumTorrentReplyFromInput`, `listForumTorrentReplies` |

The model bounds one request and treats parsing, relay reads, signing and publication as outcomes. Its duplicate rule covers results present in the observed snapshot. Concurrent publishers and stale relay reads are outside that rule. Replies use the forum's separate signature, routing and moderation logic.

TLC checked `DuplicateNeverPublished` and `RequiresEnabledCategory` in 254 states. `Torrent-mutant.cfg` bypasses rejection for a duplicate. For a source replay, in a disposable checkout run `python3 "$skill/references/check-torrent-duplicate.py"` to add a second publish assertion to the existing loopback-relay test, then run the tests above. Bypassing `checked.duplicate` in `publishForumTorrentFromInput` makes the assertion fail. Restore both files and rerun the original tests before updating reviewed refs.
