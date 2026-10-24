#!/bin/bash
# Build @impz/testing and pack the tarball npm publishes, in build/npm/.
# Prints the tarball's path.
#
#   scripts/release/pack-testing.sh
#
# The package is impd itself on stand-ins, so the bundle holds every private
# @impz package and ssh2, whose bun patch an install from npm would not apply.
# Its source imports each daemon module by its own entry, never the testing
# barrel, which would pull msw and faker into the bundle.
# Each other package the bundle imports becomes a dependency on the catalog's
# version, and @impz/client one on this release's version.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
package=$root/packages/testing
stage=$root/build/npm/imp-testing
declarations=$root/build/npm/imp-testing-types

rm -rf "$stage" "$declarations"
mkdir -p "$stage/dist"

# every catalog package but ssh2 stays outside the bundle; ssh2's native
# addons stay out too, since ssh2 falls back to JavaScript without them
mapfile -t externals < <(jq -r '.workspaces.catalog | keys[] | select(. != "ssh2")' "$root/package.json")

external_args=(--external @impz/client --external cpu-features --external '*.node')

for name in "${externals[@]}"; do
  external_args+=(--external "$name")
done

bun build "$package/src/index.ts" --target=bun --format=esm \
  --outfile "$stage/dist/index.js" "${external_args[@]}" >&2

"$root/node_modules/.bin/tsrs" -p "$root/packages/tsconfig.testing-dts.json" \
  --outDir "$declarations" >&2

for name in index start-test-impd test-token types; do
  cp "$declarations/packages/testing/src/$name.d.ts" "$stage/dist/"
done

cp "$package/README.md" "$root/LICENSE" "$stage/"

# the packages the bundle imports, read from its import, side-effect import and
# require specifiers;
# a name outside the catalog is no package, so the match drops it
imported=$(grep -ohE "(from ?|import ?\(?|require\()\"[^\"./][^\"]*\"" "$stage/dist/index.js" |
  sed -E 's/^(from ?|import ?\(?|require\()"//; s/"$//' |
  sed -E 's#^(@[^/]+/[^/]+|[^@/][^/]*).*#\1#' | sort -u | jq -R . | jq -s .)

version=$(jq -r .version "$package/package.json")

jq --slurpfile workspace "$root/package.json" --argjson imported "$imported" --arg version "$version" '
  $workspace[0].workspaces.catalog as $catalog
  | .dependencies = (
      [$imported[] | select($catalog[.] != null) | { key: ., value: ("^" + $catalog[.]) }]
      | from_entries
      | . + { "@impz/client": $version }
    )
  | del(.scripts, .devDependencies)
  | .exports = { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } }
  | .files = ["dist"]
  | .publishConfig = { access: "public" }
' "$package/package.json" >"$stage/package.json"

if grep -Eq '"(catalog|workspace):' "$stage/package.json"; then
  echo "pack-testing: the packed package.json still has a catalog: or workspace: version" >&2
  exit 1
fi

name=$(cd "$stage" && npm pack --silent --pack-destination "$root/build/npm")
echo "$root/build/npm/$name"
