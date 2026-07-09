# Releasing nowhere-cli

## Package identity

This repository publishes the npm package `nowhere-cli`. Its `bin` entry installs an executable named `nowhere`.

| Purpose | Command or name |
| --- | --- |
| npm package | `nowhere-cli` |
| Installed executable | `nowhere` |
| One-off npm execution | `npx nowhere-cli --help` |
| Global installation | `npm install --global nowhere-cli` |

The npm package `nowhere` is an unrelated project published by another maintainer. Do not publish this CLI under that name and do not change that package.

Inside this repository, `npm exec --offline -- nowhere` and `npx nowhere` may resolve the current package's local `bin` entry. A successful local command therefore does not prove that this CLI exists on the npm registry. Check the registry explicitly:

```bash
npm view nowhere-cli name version dist-tags bin repository --json
```

## Release checklist

1. Start from a clean `main` synchronized with `origin/main`.
2. Choose the next semantic version and update `package.json` and `CHANGELOG.md`.
3. Run `pnpm check` and `npm publish --dry-run`.
4. Run `npm pack`, install the resulting tarball into a clean temporary directory, and verify `nowhere --version` and a representative command.
5. Verify npm authentication with `npm whoami` and confirm the account can publish `nowhere-cli`.
6. Publish with `npm publish --access public`.
7. Verify `npm view nowhere-cli version` and install the published version from the registry.
8. Only after npm verification, create and push the signed or annotated `v<version>` tag and create the matching GitHub Release from `CHANGELOG.md`.

The `prepublishOnly` lifecycle runs the full repository checks, while `prepack` builds `dist`. The CLI reads its displayed version from the packaged `package.json`; do not add a second hardcoded version in source code.

## Failed release

Do not create a Git tag or GitHub Release if npm publication fails. Fix the release commit, rerun the checklist, and publish the same version only if the registry still shows that version as available. npm versions are immutable after publication.
