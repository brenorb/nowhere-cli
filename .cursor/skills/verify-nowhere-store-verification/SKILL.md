---
name: verify-nowhere-store-verification
description: Verify historical rate selection, fallback, and seller order verification when changing the Nowhere store verify command.
---

# Verify seller totals and historical payment checks

Seller verification recomputes totals and then uses a supplied, native, cached or fetched rate to compare payment amounts. When every required rate is unavailable, matching totals can still produce `ok: true`. Inspect the rate source and amount fields when interpreting the result.

```sh
skill=.cursor/skills/verify-nowhere-store-verification
sh scripts/check-cli-state-machine.sh "$skill/Rates.tla"
sh scripts/check-cli-state-machine.sh "$skill/Verification.tla"
sh scripts/check-cli-state-machine.sh "$skill/Verification.tla" "$skill/Verification-required.cfg"
pnpm exec vitest run tests/e2e/store-live.test.ts
```

Use Java 11 or later and set `TLA2TOOLS` to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

## Coverage

Reviewed `src/lib/store-live.ts` at main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`. Main uses the shared HTTP deadline for provider requests. Both revisions use the same rate selection and verification rules.

| Transition | Source |
| --- | --- |
| Decode receipt, encrypted event or plain order | `parseOrderPayload`, `verifyStoreOrderPayload` |
| Resolve store, calculate expected totals, and start payment checks | `verifyStoreOrder`, `computeDiscount`, `computeShipping` |
| Use override, native or cached rate, or combine available historical providers | `verifyStoreOrder`, `getHistoricalRate`, `fetchKrakenHistorical`, `fetchCoingeckoHistorical` |
| Report amount mismatch or unavailable rate | `verifyStoreOrder` |

The rate model bounds one lookup with two providers and represents each response as available or failed. A cached source denotes an existing valid entry. The verification model treats a positive comparable amount and a supplied payment value as a requested check. It abstracts exact currency math, time resolution and per-provider response shape. TLC checked 20 rate states and 144 verification states.

```sh
sh scripts/check-cli-state-machine.sh "$skill/Verification.tla" "$skill/Verification-unavailable.cfg"
```

This config fails `SuccessChecksRequestedPayment`. The source replay uses a local relay and a mocked provider. In a disposable checkout, run `python3 "$skill/references/extend-rate-tests.py"` and the test suite above. The fixture checks fallback to one available provider and cache reuse. It also checks that a mismatched payment rejected with a rate can return success if neither provider has a rate. All eight tests passed with the added cases. The required-check config models treating an unavailable rate as failure when payment verification was requested.

Use pstack’s `/statechart` to inspect the shortest path for a failing rule or visualize the checked flow. When the source changes, update the reviewed revision after rechecking the model and source fixture.
