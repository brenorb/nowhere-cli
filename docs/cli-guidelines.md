# Command Line Interface Guidelines

This records the applicability review of [clig.dev](https://clig.dev/) for the `nowhere` executable. The CLI manages local encoded fragments and optionally publishes explicit Nostr events. It has no full-screen interface, background daemon, installer side effects, or analytics.

| Guide area | Contract and evidence |
| --- | --- |
| Basics | Commander parses arguments. Results and JSON use stdout; prompts, authorization guidance, and failures use stderr. Success exits 0; failure exits nonzero. CLI contract tests cover streams and statuses. |
| Help and discovery | Bare invocation displays help successfully; `-h`, `--help`, and `help <command>` work offline. Explicit help takes precedence over incomplete options. Root help includes examples; all command help links to documentation and issues. |
| Documentation | README contains installation, examples, automation/streams, secret files, configuration locations, and network behavior. Builder/tag references and release instructions remain linked. |
| Human and machine output | Default output uses labeled fields. `--json` preserves the existing structured schema; watch JSON is newline delimited, and order/signature export offers CSV. No terminal-only styling, progress animation, or color is emitted into pipes. |
| Errors | Invalid JSON identifies its source without echoing private input. Unknown flags receive Commander diagnostics. Numeric values are validated before actions. Invalid local state is preserved with recovery instructions. |
| Arguments and secrets | Long options are retained for scripts; `--` delimits positional input. Every key/password/access-code/pairing option has a protected-file alternative. Direct and file sources conflict instead of silently taking precedence. |
| Interactivity | Creation prompts require explicit `-i`/`--interactive`. That mode deliberately supports scripted newline-separated input as well as terminals; ordinary commands never prompt. JSON from `--input -` rejects an interactive terminal immediately and reports malformed/empty input. EOF during required prompt fields fails clearly. |
| Subcommands | Existing noun/verb command paths and aliases remain stable. No implicit correction of commands or options triggers a mutation. |
| Robustness | HTTP response bodies, signer name discovery, and remote signer RPC requests have finite timeouts. Relay operations retain their client's finite connection/query defaults. Failed signer acquisition releases relay resources. State is written privately via complete temporary files and atomic rename. |
| Future compatibility | Explicit JSON schemas and command paths are preserved; new flags are additive. Human output is intentionally presentation text; scripts should select JSON or CSV. |
| Signals and pipes | Ctrl-C/termination retain normal process signal behavior; watch mode handles signals to stop polling and clean up. Closed stdout pipes exit quietly rather than printing EPIPE stack traces. Watch duration can be bounded explicitly. |
| Configuration | State uses an absolute `XDG_CONFIG_HOME` or `~/.config/nowhere-cli`. Private writes use directory 0700/file 0600. `NOWHERE_FORUM_SESSION_SECRET` remains an explicit override; a file/remote signer is preferable for other secrets. No implicit credentials from new environment variables are introduced. |
| Naming and distribution | The executable is `nowhere`, npm package `nowhere-cli`. Package identity, Node requirement, bundled codec, tarball checks, and release steps are documented. Installation does not require the development codec checkout. |
| Analytics | None. No telemetry or update check was added. |

Optional additions such as generated man pages or completion scripts are not required for using any command: offline `--help` and the maintained web documentation cover supported usage. Existing explicit relay publication and invoice commands perform the requested operation without an extra interactive confirmation; local `create` only encodes/signs/encrypts a fragment and does not publish a site to a relay.

## Maintainer checks

Run `pnpm check` for lint, types, and the entire test suite, and `pnpm build` for the bundled executable. The e2e suite uses local mock relays and a mock remote signer. `tests/e2e/cli-contract.test.ts`, `tests/secret-input.test.ts`, and `tests/network-timeouts.test.ts` exercise the added contracts, including a stalled HTTP body and a remote signer timeout that must actually exit. Follow [releasing.md](releasing.md) to check a packed installation.

The local `@nowhere/codec` dependency is a pre-existing development dependency. README pins the upstream checkout used for validation; npm releases bundle that codec and do not resolve the local path for users.
