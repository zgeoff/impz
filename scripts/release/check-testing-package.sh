#!/bin/bash
# Install a packed @impz/testing (scripts/release/pack-testing.sh) into an empty
# Bun project, as a user would, beside the @impz/client tarball of the same
# release, which npm may not have yet. Then run packages/testing/smoke/ under
# bun test, and check its types against the published declarations only.
#
#   scripts/release/check-testing-package.sh build/npm/impz-testing-X.Y.Z.tgz build/npm/impz-client-X.Y.Z.tgz
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
smoke=$root/packages/testing/smoke
testing=$(realpath "$1")
client=$(realpath "$2")
project=$(mktemp -d)
trap 'rm -rf "$project"' EXIT

cd "$project"

jq -n --arg client "file:$client" '{
  name: "impz-testing-check",
  private: true,
  type: "module",
  overrides: { "@impz/client": $client }
}' >package.json

# an isolated install exposes only the declared dependencies, so one the
# manifest misses fails the import, where a hoisted install would hide it
printf '[install]\nlinker = "isolated"\n' >bunfig.toml

bun add --dev "$client" "$testing" "@types/bun@$(jq -r '.workspaces.catalog["@types/bun"]' "$root/package.json")" >/dev/null

# bun test runs only a *.test.ts file, and the lint rule for one wants a module beside it
cp "$smoke/smoke.ts" smoke.test.ts
cp "$smoke/smoke.tsconfig.json" .

bun test ./smoke.test.ts
echo "the installed package runs under bun test"

"$root/node_modules/.bin/tsc" -p smoke.tsconfig.json
echo "the declarations check in a strict project"
