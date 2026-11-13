---
name: verify-nowhere-package
description: Check build, npm package contents and standalone installation when changing Nowhere's CLI package or packed smoke tests.
---

# Verify the installed CLI package

The build creates the `nowhere` Node entrypoint and bundles the development codec. The packed test builds a tarball, installs it in a temporary project, and exercises the installed command there.

Use Java 11 or later with `TLA2TOOLS` pointing to [TLC 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Run from a checkout with its configured development dependencies installed.

```sh
skill=.cursor/skills/verify-nowhere-package
sh scripts/check-cli-state-machine.sh "$skill/Package.tla"
sh "$skill/references/check-packed-cli.sh"
pnpm run test:e2e:packed
```

## Coverage

Reviewed main `fdf33c73fd2721dcf6209e0c4ee2e337cf315db9` and tag `v0.3.0` at `a61ebfc649ad670282223794a30ab92fe862034d`. The build configuration and package entrypoint are the same. The packed end-to-end entrypoint was added after the tag.

| Transition | Source |
| --- | --- |
| Run prepublish checks or build before normal packing | `package.json`, `check`, `prepublishOnly`, `prepack` |
| Build a Node ESM entrypoint and bundle the codec | `tsup.config.ts`, entry, banner and `noExternal` |
| Pack, install, verify entrypoint and exercise packaged commands | `tests/e2e/packed-cli.ts`, setup, version check, tests and cleanup |

The model bounds one build and installation, abstracts package manager and filesystem errors, and checks the development codec requirement at the installed-package smoke test. It omits registries, publishing and transitive dependency behavior. The local replay inspects the actual tarball. The two packed source tests installed the CLI into a temporary project and exercised local signing and relay fixtures.

TLC checked 15 states. `Package-mutant.cfg` permits a package without the bundled codec. In a disposable checkout, replace `noExternal` with `external` for the codec in `tsup.config.ts`. The tarball replay detects the resulting external development import. Restore and rerun before updating the reviewed refs.

Use pstack’s `/statechart` to inspect the shortest path for a failing rule or visualize the checked flow. When the source changes, update the reviewed revision after rechecking the model and source fixture.
