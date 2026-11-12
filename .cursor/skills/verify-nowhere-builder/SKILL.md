---
name: verify-nowhere-builder
description: Check tool selection, scripted and terminal prompts, required answers, and cancellation when changing interactive Nowhere site creation.
---

# Verify interactive site creation

Answering no at the summary must stop creation. A builder that ignores this answer can return a site link after the user cancelled.

Run with Java 11 or later and `TLA2TOOLS` pointing to the official [TLC 1.7.4 JAR](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
sh scripts/check-cli-state-machine.sh .cursor/skills/verify-nowhere-builder/Builder.tla
node .cursor/skills/verify-nowhere-builder/references/check-create-cancel.mjs
pnpm exec vitest run tests/e2e/create-long-form.test.ts
```

## Coverage

Reviewed at `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`. The prompt, field collection and confirmation functions are identical at these refs.

| Transition | Source |
| --- | --- |
| Validate flags, open prompt session, choose tool and initialize payload from supplied fields | `src/lib/create-interactive.ts`, `resolveInteractiveCreateInput` and `promptTool`; `src/lib/create-long-form.ts`, `validateCreateCommandOptions` and `buildCreatePayloadFromOptions` |
| Collect missing fields, retry invalid input, fail on exhausted required answers | `src/lib/create-field-prompts.ts`, `promptToolFields`; `src/lib/create-prompt-session.ts`, `createPromptSession` and `promptLine` |
| Review, confirm or decline, and close the session | `resolveInteractiveCreateInput`, `printSummary` and `promptYesNo` |
| Build and output a link on the successful path | `src/cli.ts`, `create` action |

The model bounds one command and summarizes the form by whether a required answer is still missing. The confirmation step accepts an explicit yes, a blank default or exhausted scripted input at that step. Required-answer exhaustion fails earlier. Per-tool schemas, repeated optional field contents and final link protection have their own code paths. See [the site protection skill](../verify-nowhere-site-protection/SKILL.md) for the last of these.

TLC checked `DeclinePreventsCreation` in 22 states. Supply `Builder-mutant.cfg` as the second argument to see the builder proceed after a decline. Use pstack's `/statechart` to interpret the trace. In a disposable checkout, bypass the cancellation branch in `resolveInteractiveCreateInput` while still awaiting the prompt. The local fixture catches a returned link on that path. Restore and rerun before advancing the reviewed commit.
