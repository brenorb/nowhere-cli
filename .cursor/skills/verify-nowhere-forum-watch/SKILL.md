---
name: verify-nowhere-forum-watch
description: Check snapshot and live event streaming, deduplication, and stop behavior when changing Nowhere forum watch commands.
---

# Verify forum watch streaming

A watch labels its first poll as a snapshot. Later polls emit newly observed event IDs as live events. A signal or duration limit ends the watch after the in-flight poll settles.

Use Java 11 or later with `TLA2TOOLS` pointing to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Run from the repository root with dependencies installed.

```sh
skill=.cursor/skills/verify-nowhere-forum-watch
sh scripts/check-cli-state-machine.sh "$skill/Watch.tla"
pnpm exec vitest run tests/e2e/live-commands.test.ts -t 'forum watch mode streams'
```

## Coverage

Reviewed main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`. Both versions use the same polling and deduplication loop. Main uses the shared bounded option parser for the watch duration.

| Transition | Source in `src/cli.ts` |
| --- | --- |
| Decide whether to watch and parse the duration | `addWatchOptions`, `watchRequested`, `readWatchDurationMs` |
| Fetch the initial snapshot and remember emitted IDs | `watchEntries`, `printWatchRecord` |
| Poll again and stream unseen IDs | `watchEntries` |
| End on a signal, elapsed duration or read error and unregister signal handlers | `watchEntries` |
| Watch forum posts, replies, torrents, torrent replies, chat, rooms and voice signals | All nine `watchEntries` call sites |

The model bounds two event IDs and one poll in flight. It abstracts interval and deadline clocks, payload, output format and within-batch order. It permits the in-flight poll to emit after a signal or deadline. Each poll can return either, both or neither of the event IDs, so the checker covers repeats across polls.

TLC checked `NoRepeatedEvent` in 160 states. Run `Watch-mutant.cfg` with the same checker to observe a repeated event. In a disposable checkout, bypass `seen.has(entry.eventId)` in `watchEntries`. The loopback-relay test above observed four copies of the same post with that mutation and one with current source. It also checks the live phases for torrent, chat and voice events. Restore the guard and rerun the tests before updating the reviewed refs. [Statechart and regeneration command](../../../docs/statecharts/forum-watch.md)
