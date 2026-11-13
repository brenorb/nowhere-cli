---
name: verify-nowhere-forum-session
description: Check environment override, corruption handling, and competing first writes when changing the Nowhere forum session identity.
---

# Verify the forum session identity

Forum commands can use an environment override or a saved session identity. In the absence of both, the CLI generates an identity, persists it and returns it to the caller. An unreadable or invalid session file causes an error.

Use Java 11 or later with `TLA2TOOLS` pointing to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Run from the repository root with the project dependencies installed.

```sh
skill=.cursor/skills/verify-nowhere-forum-session
sh scripts/check-cli-state-machine.sh "$skill/Session.tla"
node --import tsx "$skill/references/check-first-session.mjs"
pnpm exec vitest run tests/secret-input.test.ts
```

## Coverage

Reviewed main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`. Both check the override before reading the file and generate after an absent file. The tag writes directly and uses its own config path logic. Current source uses a private temporary file and rename in `src/lib/private-files.ts`, and absolute config directory resolution in `src/lib/config.ts`.

| Transition | Source in `src/lib/forum-session.ts` |
| --- | --- |
| Read an override or resolve the session path | `getForumSessionMaterial`, `getForumSessionPath` |
| Read a saved secret, return absence for ENOENT, or fail for corruption | `readPersistedForumSession` |
| Generate a new secret, publish the saved file, and return the secret | `getForumSessionMaterial`, `writePersistedForumSession` |

The model covers two concurrent calls and one file. Secrets are represented by distinct labels. An override is represented as a valid identity separate from disk. An invalid override fails in `describeSecret`; the model omits secret format, platform-specific permissions and partial writes in the old release.

TLC checked `CorruptFileIsPreserved` in 46 states. The secret input suite passed 15 tests, including keeping corrupt file bytes unchanged. The `Session-race.cfg` config also checks `ReturnedSessionIsPersisted` and finds a four-step failure. Both callers read absence, both generate, and the second save replaces the first secret. The local fixture invokes current code concurrently in a temporary config home. It verifies that the calls return different identities, the saved file contains exactly one of them, and a later call returns the saved identity. The write in the tagged source also occurs after the unguarded missing-file check.

```sh
sh scripts/check-cli-state-machine.sh "$skill/Session.tla" "$skill/Session-race.cfg"
sh scripts/check-cli-state-machine.sh "$skill/Session.tla" "$skill/Session-reuse.cfg"
```

The race check exits with an invariant violation. The reuse config checks a model alternative in which a caller encountering an existing identity at commit uses that identity. Its 44 states satisfy both rules. On changes, rerun the checks, compare the returned identities and update the reviewed refs and expected outcomes.
