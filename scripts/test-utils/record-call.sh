# shellcheck shell=bash
# Source this file, then call
#   record_call <name> <calls file> [<variable>...] -- [<argument>...]
# to append one call to the calls.jsonl that the testing kit's readStubCalls reads. The variables
# are recorded with the call, empty when unset.

record_json_string() {
  local text=${1//\\/\\\\}
  text=${text//\"/\\\"}
  printf '"%s"' "$text"
}

record_call() {
  local name=$1 calls=$2 variable args='' env=''
  shift 2

  for variable; do
    [ "$variable" = -- ] && break
    env+="$(record_json_string "$variable"):$(record_json_string "${!variable-}"),"
    shift
  done
  shift

  local argument
  for argument; do
    args+="$(record_json_string "$argument"),"
  done

  printf '{"name":%s,"argv":[%s],"cwd":%s,"env":{%s},"stdin":""}\n' \
    "$(record_json_string "$name")" "${args%,}" "$(record_json_string "$PWD")" "${env%,}" >> "$calls"
}
