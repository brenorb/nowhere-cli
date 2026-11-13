---
name: verify-nowhere-http-deadline
description: Check request deadline and caller cancellation when editing the Nowhere shared HTTP adapter or CLI timeout propagation.
---

# Verify HTTP deadline propagation

Main at `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` applies the parsed CLI timeout in `src/cli.ts`. `src/lib/network.ts::fetchWithTimeout` captures the current timeout for each request and combines it with an existing caller signal. Historical exchange rate and Lightning callers pass through the wrapper. The cited `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d` uses direct fetch in those callers.

Use Java 11 or later and set `TLA2TOOLS` to the absolute path of the official [TLC 1.7.4 JAR](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
dir=.cursor/skills/verify-nowhere-http-deadline
sh scripts/check-cli-state-machine.sh "$dir/Deadline.tla"
sh scripts/check-cli-state-machine.sh "$dir/Deadline.tla" "$dir/Deadline-legacy.cfg"
sh scripts/check-cli-state-machine.sh "$dir/Deadline.tla" "$dir/Deadline-mutant.cfg"
node --import tsx "$dir/references/check-http-deadline.mjs"
```

The finite model bounds one request before headers, after headers, and after body completion. It checks that a fired deadline or caller signal applies to unfinished work. The legacy config omits the internal deadline. The mutant drops the caller signal. Both must fail their corresponding invariant. The source fixture uses the native fetch implementation against a loopback HTTP server and asserts the two cancellation reasons as well as successful completion. In a disposable checkout, use the timeout alone as the fetch signal and rerun to catch the lost caller reason.

The model treats signal delivery and fetch settlement as one step and leaves response parsing and retries to the callers. Use pstack's `/statechart` to inspect shortest paths. Advance the reviewed revision after checking changes against the model and fixture.
