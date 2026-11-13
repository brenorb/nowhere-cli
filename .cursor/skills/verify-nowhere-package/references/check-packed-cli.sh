#!/bin/sh
set -eu
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
pnpm build
npm pack --ignore-scripts --silent --pack-destination "$stage" > "$stage/name"
archive="$stage/$(cat "$stage/name")"
tar -xf "$archive" -C "$stage"
package="$stage/package"
test -f "$package/dist/cli.js"
test "$(head -1 "$package/dist/cli.js")" = '#!/usr/bin/env node'
if grep -E 'from ["'\'']@nowhere/codec["'\'']' "$package/dist/cli.js"; then
    echo 'Packaged CLI imports the development codec' >&2
    exit 1
fi
