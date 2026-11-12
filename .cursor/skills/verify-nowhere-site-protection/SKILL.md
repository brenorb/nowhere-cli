---
name: verify-nowhere-site-protection
description: Model-check the final Nowhere link when changing create, update, signing, encryption, or verification of a generated site.
---

# Verify Nowhere link protection

When a user requests signing and encryption together, decrypting the final link must recover the signed fragment. Otherwise the recipient can open the page but cannot verify its signer.

Run with Java 11 or later and `TLA2TOOLS` set to the absolute path of the official [TLA+ 1.7.4 release JAR](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).

```sh
sh scripts/check-cli-state-machine.sh .cursor/skills/verify-nowhere-site-protection/SiteProtection.tla
```

## Coverage

Reviewed at `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9`. The Freedom Skills `0.3.0` baseline at `a61ebfc649ad670282223794a30ab92fe862034d` has the same protection and verification actions.

| Model | Source |
| --- | --- |
| Create builds a new fragment. Update opens the previous link, reads the patch, and builds a new fragment from the merged data. | `src/cli.ts`, `create` and `update` actions, `buildSite`, `deepMerge` |
| Sign the new fragment, then encrypt the active fragment when requested. | `src/cli.ts`, `finalizePublish`, `signFragmentWithSigner`, and the codec's `encryptFragment` |
| Print the final URL and later decrypt and verify it. | `finalizePublish`, the `verify` and `decrypt` actions, `src/lib/fragments.ts`, `resolveSiteInput`, and `src/lib/site-signature.ts`, `verifySiteSignature` |

The model bounds one create or update and one verification, with each combination of signing and encryption. An update builds a new fragment and takes its protection from the update flags. The model assumes valid keys for successful signing and treats build, import, signing, and encryption errors as failures. It abstracts fragment bytes, codec internals, signer pairing, and output fields other than the final link.

The baseline exhausted 66 states. A mutant that encrypts the unsigned fragment fails when the final link is printed. Changing the corresponding argument in scratch source made the existing CLI round-trip test decrypt an unsigned page. The test passed again after restoring the active fragment.

## Verify a change

1. Compare the covered actions with the reviewed commit and track the fragment through signing, encryption and printing.
2. Run the checker. Supply `.cursor/skills/verify-nowhere-site-protection/SiteProtection-broken.cfg` as the second argument to verify the invariant catches encrypting the unsigned copy. Inspect counterexamples with pstack's `/statechart`.
3. Run `npm test -- tests/e2e/builders.test.ts -t 'can encrypt after signing'` with dependencies installed. In a disposable checkout, change the first argument of `encryptFragment(activeFragment, encryptPassword)` inside `finalizePublish` to `unsignedFragment` and confirm the test fails. Restore the original argument and rerun the test.
4. Advance the reviewed commit once the model matches the code.
