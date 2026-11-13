---
name: verify-nowhere-command-dispatch
description: Check help dispatch, bounded numeric options, JSON input, and alternate secret sources when changing the Nowhere command parser.
---

# Verify command preflight

Nowhere handles bare and help invocations before normal argument validation. Ordinary commands parse and validate options, then resolve sensitive options from a direct value or file before the action runs. File and stdin JSON parsing reports the input source on failure.

Use Java 11 or later with `TLA2TOOLS` pointing to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
skill=.cursor/skills/verify-nowhere-command-dispatch
sh scripts/check-cli-state-machine.sh "$skill/Dispatch.tla"
sh scripts/check-cli-state-machine.sh "$skill/SecretFiles.tla"
pnpm exec vitest run tests/e2e/cli-contract.test.ts tests/secret-input.test.ts
```

## Coverage

Reviewed main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`. Main added `cli-conventions.ts`, early help, recursive numeric parsers, and secret-file preflight.

| Transition | Source |
| --- | --- |
| Select early help or normalize positional fragments before Commander parsing | `src/cli.ts`, `normalizeLeadingDashPositionalArg`, final dispatch; `cli-conventions.ts`, `requestedHelp`, `configureHelp` |
| Validate bounds and apply request timeout | `cli-conventions.ts`, `configureNumericOptions`, `positiveSeconds`; `cli.ts`, root pre-action hook |
| Resolve inline or file source, reject conflicts or missing requirements | `cli-conventions.ts`, `configureSecretFiles` |
| Read and parse JSON, render results or report errors | `io.ts`, `readJsonInput`; `output.ts`; `cli.ts`, final error handler |

The dispatch model bounds one command and represents recognized help and flag validity as inputs. The secret file model bounds one option and treats unreadable or empty input as one failure. These models abstract command grammar, parsing details and I/O. They omit per-command behavior after successful preflight.

TLC checked dispatch in 19 states and secret preflight in 36. The mutants move help after validation or allow two secret sources. In a disposable checkout, disable the early `requestedHelp` result in `cli.ts` or bypass the conflict guard in `configureSecretFiles`. The CLI contract or ambiguous-secret test catches the corresponding mutation. All 27 baseline tests passed. Restore and rerun before updating reviewed refs.
