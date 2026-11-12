---
name: verify-nowhere-relays
description: Check shared Nowhere relay publication and count reconciliation when changing pool behavior, fallback queries, or caller success policies.
---

# Verify relay outcomes

A strict publish needs at least one relay accepted by the client's success policy. A count query uses the largest successful count and fetches events only when all count calls fail. Otherwise the CLI can report a publish that failed everywhere or understate the count returned by its relays.

Run with Java 11 or later and `TLA2TOOLS` pointing to the official [TLC 1.7.4 JAR](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
sh scripts/check-cli-state-machine.sh .cursor/skills/verify-nowhere-relays/Relays.tla
sh scripts/check-cli-state-machine.sh .cursor/skills/verify-nowhere-relays/RelayCount.tla
node --import tsx .cursor/skills/verify-nowhere-relays/references/check-relay-outcomes.mjs
```

## Coverage

Reviewed at `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`. The shared relay helpers are identical at these refs.

| Transition | Source in `src/lib/relay.ts` |
| --- | --- |
| Create a pool lazily, reuse it, then destroy and forget it | `getPool`, `destroyPool` |
| Deduplicate publish destinations, settle all results, classify fulfilled connection failures separately | `publishToRelays` |
| Wait for settled publishes and return regardless of individual relay outcomes | `publishToRelaysBestEffort` |
| Count each relay, select the maximum successful count, or query events after all count failures | `countEvents`, `fetchEvents` |

Each model bounds two relays, one operation and all modeled response orderings. Count replies range from zero to two. Publication acceptance means a fulfilled result whose value does not begin with the SDK's connection-failure prefix. Remote storage, eventual query visibility, socket behavior, SDK retries, and caller-specific order, petition, and forum state are outside these models. The pool reference ownership is recorded here as the entry and exit around both operations.

TLC checked `StrictReturnNeedsAcceptance` in 50 states and `ReportLargestCount` in 45 states. Supply the matching `-mutant.cfg` as the second argument to see the guard fail. Use pstack's `/statechart` to interpret each trace.

The local fixture replaces the SDK methods with resolved and rejected promises. In a disposable checkout, count every fulfilled publish as a success or return the first successful count in place of the maximum. The fixture catches either change. Restore the original logic and rerun before advancing the reviewed commit.
