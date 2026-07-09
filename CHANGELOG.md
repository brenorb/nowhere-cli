# Changelog

All notable changes to this project are documented in this file. This project follows [Semantic Versioning](https://semver.org/).

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

[0.2.0]: https://github.com/project-maintainer/nowhere-cli/releases/tag/v0.2.0
