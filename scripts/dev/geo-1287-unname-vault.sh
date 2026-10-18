#!/usr/bin/env bash
# Points every 1Password reference to the e2e vault at $IMP_OP_VAULT, so no
# file names the owner's vault. Takes the vault name as its argument, so this
# public file never spells it. The unit tests of scripts/lib.sh name an
# invented vault by hand. Run once from the repo root:
#   bash scripts/dev/geo-1287-unname-vault.sh <vault>
set -euo pipefail

vault="${1:?usage: geo-1287-unname-vault.sh <vault>}"

mapfile -t files < <(git grep -l -F "op://${vault}/" -- . ':!scripts/lib.test.ts')

for file in "${files[@]}"; do
  sed -i -e "s#op://${vault}/#op://\$IMP_OP_VAULT/#g" "$file"
done
