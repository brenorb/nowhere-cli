---
name: verify-nowhere-petition
description: Verify petition response validation, publication, and owner pagination when changing Nowhere petition commands.
---

# Verify petition signing and owner retrieval

Signing validates required fields and restrictions, encrypts the response for the owner, computes proof of work, signs and verifies the event, then publishes. Owner retrieval pages through relay events, keeps the newest per signer, filters by proof of work, and reports decryption failures per entry.

Use Java 11 or later with `TLA2TOOLS` pointing to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Run the local source replay from the repository root with project dependencies available.

```sh
skill=.cursor/skills/verify-nowhere-petition
sh scripts/check-cli-state-machine.sh "$skill/Signature.tla"
node --import tsx "$skill/references/check-petition.mjs"
pnpm exec vitest run tests/e2e/petition-live.test.ts
```

## Coverage

`src/lib/petition-live.ts` is identical at main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`.

| Transition | Source in `src/lib/petition-live.ts` |
| --- | --- |
| Validate response and select local, remote or anonymous signer | `validatePetitionSignaturePayload`, `publishPetitionSignature` |
| Encrypt, compute proof of work, sign, verify and publish | `publishPetitionSignature`, `applyPoW` |
| Count by petition tag through the configured transport | `countPetitionSignatures`, `createSimplePoolPetitionTransport` |
| Advance the timestamp cursor and collect distinct events | `fetchPetitionEventsPaginated` |
| Select newest per signer, check proof of work, and decrypt or record an error | `fetchPetitionSignaturesForOwner` |

`Signature.tla` bounds one publish and abstracts validation to accepted or rejected, cryptographic operations to outcomes, and relay behavior to a publication outcome. It covers the CLI path that supplies petition tags and a signer that signs the requested event. `Pagination.tla` bounds three matching events and a relay that returns at most one per request, newest first. It assumes an inclusive `until` cutoff and two events with the same timestamp. It models collection before per-signer selection or decryption.

TLC checked `PublishReadySignature` in 12 states. `Signature-mutant.cfg` disables required field validation. In a disposable checkout, bypass `validatePetitionSignaturePayload` in `publishPetitionSignature`. The replay then fails because the missing name reaches the local publication path instead of being rejected. [Signing statechart](../../../docs/statecharts/petition-sign.md)

## Existing pagination gap

The next page uses `oldest - 1`. If a relay caps a result in the middle of a timestamp, this cursor skips unseen events at the same timestamp. TLC and pstack show the failure in three steps. The relay returns one of the two newer events, then the older event, then an empty page. The in-memory fixture runs the production signing and retrieval functions with ephemeral keys and a relay double. Count reports three and the owner retrieves two.

```sh
sh scripts/check-cli-state-machine.sh "$skill/Pagination.tla"
```

This config exits with an invariant violation for the existing behavior. On changes, rerun the test suite and both model checks, then update the reviewed refs and expected outcomes.
