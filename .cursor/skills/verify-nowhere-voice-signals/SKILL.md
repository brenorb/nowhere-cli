---
name: verify-nowhere-voice-signals
description: Check Nowhere forum voice event routing, channel selection, and join-signature reporting when changing voice send or list.
---

# Verify forum voice signaling

Send derives a general, room or private destination and includes an inner signature for joins. List decrypts and filters by payload, channel and optional author. It reports join signature validity on accepted rows.

Use Java 11 or later with `TLA2TOOLS` pointing to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
skill=.cursor/skills/verify-nowhere-voice-signals
sh scripts/check-cli-state-machine.sh "$skill/Signals.tla"
pnpm exec vitest run tests/e2e/live-commands.test.ts -t 'forum commands publish posts|forum watch mode streams'
```

## Coverage

`src/lib/forum-live.ts` is identical at main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`.

| Transition | Source in `src/lib/forum-live.ts` |
| --- | --- |
| Validate channel inputs and choose recipient and session | `publishVoiceSignal`, `deriveVoiceChannel`, `deriveRoomKeypair` |
| Attach proof to a join, encrypt, and send signaling event | `publishVoiceSignal`, `signWrappedContent` |
| Decrypt candidate, check payload shape and filter expected channel and author | `listVoiceSignals`, `isVoiceSignalPayload` |
| Set join validation flag | `listVoiceSignals`, `verifyJoinSignal` |

The model bounds one signaling candidate, groups non-join events together and abstracts the crypto and payload details. With private listing and no peer filter, the expected-channel test is satisfied without a comparison. Invalid joins can still appear with a false flag. The CLI transports signaling records and has no WebRTC call lifecycle.

TLC checked `ListedSignalsMatch` and `JoinStatusMatches` in 480 states. The mutant ignores the requested channel. In a disposable checkout, run `python3 "$skill/references/extend-voice-test.py"` and rerun the forum publishing test. Bypassing the `expectedChannel` comparison in `listVoiceSignals` makes the wrong-channel assertion fail. Restore both disposable files, rerun and update the reviewed refs if the routing behavior changes.
