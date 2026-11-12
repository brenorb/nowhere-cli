---
name: verify-nowhere-signer
description: Check Nowhere's saved remote signer, pairing, and pending RPC lifecycle when changing signer commands or NIP-46 client handling.
---

# Verify remote signer lifecycle

Reading saved signer status must preserve the user's settings file. A sent signer request also needs a deadline so a silent signer cannot keep the CLI waiting indefinitely.

Run with Java 11 or later and `TLA2TOOLS` pointing to the official [TLC 1.7.4 JAR](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
sh scripts/check-cli-state-machine.sh .cursor/skills/verify-nowhere-signer/Signer.tla
sh scripts/check-cli-state-machine.sh .cursor/skills/verify-nowhere-signer/RPC.tla
node --import tsx .cursor/skills/verify-nowhere-signer/references/check-signer-status.mjs
node --import tsx .cursor/skills/verify-nowhere-signer/references/check-rpc-timeout.mjs
```

## Coverage

Reviewed at `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`.

| Transition | Source |
| --- | --- |
| Prepare a pairing URI, connect by bunker or wait for authorization, get the public key and save | `src/lib/active-signer.ts`, `buildNostrConnectHandshake`, `connectSignerViaBunker`, `connectSignerViaHandshake`, `Nip46Signer.persist` |
| Read, restore and explicitly remove saved state | `readPersistedSigner`, `restoreActiveSigner`, `getActiveSignerStatus`, `disconnectActiveSigner` |
| Open a subscription, register a request, show an authorization notice, accept a reply or reject on error or timeout | `src/lib/nostr-connect-client.ts`, `openSubscription`, `sendRequest` and `handleEvent` |
| Retry a lost subscription, then cancel retry and reject pending work on close | `openSubscription` and `close` |

The saved-session model has one persisted file, one pairing at a time and sequential commands. Status reflects the file rather than a live connection check. The RPC model has one outstanding request and abstracts cryptography and external relay behavior. Its deadline property applies after the timer runs. The wait-for-pairing timer and the request timer are separate.

TLC checked `ReadingPreservesSettings` in 27 states and `DeadlineSettlesRequest` in 19 states. Supply the matching `-legacy.cfg` as the second argument and use pstack's `/statechart` to interpret the paths. The cited release removes malformed saved state during a read and lacks a per-request deadline.

In a disposable current checkout, replace `src/lib/active-signer.ts` and `src/lib/nostr-connect-client.ts` with the corresponding files from `v0.3.0`. Run the fixture commands with `--expect-legacy` to observe both differences, then restore and run the current commands. Update the reviewed commit after confirming both models still correspond to their source.
