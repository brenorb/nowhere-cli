# Changelog

All notable changes to this project are documented in this file. This project follows [Semantic Versioning](https://semver.org/).

## [0.3.1] - 2026-07-31

### Added

- Added the `nowhere-cli` executable alias so explicit `npx --package=nowhere-cli -- nowhere-cli ...` invocations work.
- Added positional message content for `create message`, alongside the existing `--description` flag.

## [0.3.0] - 2026-07-31

### Added

- Shared the Hosted Nowhere currency catalog across the structured and interactive create flows.
- Added the canonical feature and user-story audit workbook with implementation and validation evidence.

### Changed

- Moved maintained create fixtures into the repository test fixture hierarchy.
- Kept signed forum fragments intact when deriving post, reply, chat, torrent, and moderation namespaces, matching the Hosted Nowhere renderer.
- Removed the non-upstream Damus relay override from the forum creation fixture so forums use the upstream relay defaults.

### Fixed

- Made interactive prompts fail clearly when scripted standard input ends before required fields are supplied.
- Rejected fractional satoshi invoice amounts instead of silently truncating them.
- Rejected conflicting `--json` and `--csv` output modes.
- Restored post and reply visibility for signed forums created and managed through the CLI.

## [0.2.0] - 2026-07-09

First public npm release.

### Added

- Create, inspect, update, sign, verify, encrypt, and decrypt Nowhere fragments.
- Builders for store, event, fundraiser, petition, message, drop, art, and forum sites.
- Interactive `create -i` flow matching the fields and canonical tags from Hosted Nowhere.
- NIP-46 remote signer pairing and persisted signer sessions.
- Relay-backed store, petition, fundraiser, message, and forum management commands.
- Store checkout, order verification and management, CSV exports, forum moderation, chat, voice, and torrent workflows.

### Changed

- Interactive creation accepts long-form flags as prefilled values and asks only for missing fields.
- Owner pubkeys accept Nowhere base64url, hex, `npub`, and copied `nostr:npub` values.
- Interactive prompt I/O, field collection, and create schemas now have separate ownership boundaries.

### Fixed

- Preserved escaped delimiters and literal backslashes in contacts, tips, and custom payment methods.
- Enforced Hosted Nowhere's required author and owner fields with clearer validation errors.

[0.3.1]: https://github.com/brenorb/nowhere-cli/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/brenorb/nowhere-cli/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/brenorb/nowhere-cli/releases/tag/v0.2.0
