#!/bin/bash
# Check a built image for the logins of Claude Code, gh and git: their
# credential files, and an Anthropic or GitHub token in a text file, the
# image's env or its build history. It finds no other kind of secret. Every
# imp booted from the image gets a copy of what it holds, so the broker adds
# each credential to requests instead.
#
#   images/examples/coder/check-no-secrets.sh IMAGE
#
# IMAGE must be in the local docker. The check reads each layer of the saved
# image, so the image needs no shell.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 IMAGE" >&2
  exit 2
fi
image=$1

status=0
fail() {
  echo "check-no-secrets: $*" >&2
  status=1
}

# Anthropic API keys and OAuth tokens (sk-ant-api03-…, sk-ant-oat01-…) and
# GitHub tokens, classic and fine-grained
tokens='sk-ant-[a-z]+[0-9]*-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}'

# the variables the broker sets to a placeholder at each exec; a value in
# the image would reach every imp that boots it
credential_vars='ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN'

# every later command names the image by this ID, so a build that moves the
# tag during the check cannot mix two images' metadata and layers
id=$(docker image inspect --format '{{.Id}}' "$image")

env=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id")
if found=$(grep -oE "^($credential_vars)=" <<< "$env"); then
  fail "the image env sets $(paste -sd ' ' <<< "$found")"
fi
if grep -qE "$tokens" <<< "$env"; then
  fail "the image env holds a token"
fi
if docker history --no-trunc --format '{{.CreatedBy}}' "$id" | grep -qE "$tokens"; then
  fail "the image history holds a token"
fi

root=$(mktemp -d)
cleanup() {
  chmod -R u+rwX "$root"
  rm -rf "$root"
}
trap cleanup EXIT

# Each layer on its own, as the saved image holds it: a file that a later
# layer deletes or overwrites is still in the image anyone pulls.
mkdir "$root/save" "$root/layers"
docker image save "$id" | tar -x -C "$root/save"
# a substitution, not a pipe into the loop, so a failed jq stops the check
layers=$(jq -r '.[0].Layers[]' "$root/save/manifest.json")
if [ -z "$layers" ]; then
  echo "check-no-secrets: $image ($id) has no layers to scan" >&2
  exit 1
fi
index=0
while read -r layer; do
  index=$((index + 1))
  mkdir "$root/layers/$index"
  tar -x -f "$root/save/$layer" -C "$root/layers/$index" --no-same-owner --exclude='dev/*'
done <<< "$layers"
# a file the image makes unreadable, such as /etc/shadow, is still scanned
chmod -R u+rX "$root/layers"

# the paths a scan of the layers finds, as the image names them
image_paths() {
  sed 's#^\./[0-9]*##' | sort -u | paste -sd ' '
}

# the files where each tool keeps its login: Claude Code's credentials and
# account state, gh's hosts and git's credential store
logins=$(cd "$root/layers" && find . \( -path '*/.claude/.credentials.json' -o -name .claude.json \
  -o -path '*/gh/hosts.yml' -o -name .git-credentials -o -name .netrc \) -print)
if [ -n "$logins" ]; then
  fail "the image holds login state: $(image_paths <<< "$logins")"
fi

# -I skips binary files, whose bytes can match by chance; a login is text
scan=0
secrets=$(cd "$root/layers" && grep -rlIE "$tokens" .) || scan=$?
if [ "$scan" = 0 ]; then
  fail "the image holds a token in $(image_paths <<< "$secrets")"
elif [ "$scan" != 1 ]; then
  fail "cannot scan the image's files for tokens"
fi

if [ "$status" = 0 ]; then
  echo "check-no-secrets: ok ($image, $id)"
fi
exit "$status"
