import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import * as z from 'zod';

interface StubTailscaleNode {
  readonly BackendState: string;
  readonly Self: {
    readonly HostName: string;
    readonly Tags: readonly string[];
    readonly TailscaleIPs: readonly string[];
    readonly DNSName: string;
  };
}

const SelfSchema = z.object({
  HostName: z.string(),
  Tags: z.array(z.string()),
  TailscaleIPs: z.array(z.string()),
  DNSName: z.string(),
});

const NodeSchema = z.object({ BackendState: z.string(), Self: SelfSchema });

interface StubTailscalePrefs {
  readonly ControlURL: string;
}

export interface StubTailscale {
  readonly bin: string;
  readonly writeNode: (node: StubTailscaleNode) => void;

  // Until prefs are written or up runs, the node is on Tailscale's own server.
  readonly writePrefs: (prefs: StubTailscalePrefs) => void;
  readonly holdStart: () => void;
  readonly releaseStart: () => void;

  readonly readNode: () => StubTailscaleNode;
  readonly readCalls: (verb: string) => readonly string[];
}

export function createStubTailscale(directory: string): StubTailscale {
  const status = join(directory, 'tailscale-status.json');
  const starting = join(directory, 'tailscale-starting');
  const prefs = join(directory, 'tailscale-prefs.json');

  const stub = createStubBin(
    directory,
    'tailscale',
    String.raw`status=${JSON.stringify(status)}
starting=${JSON.stringify(starting)}
prefs=${JSON.stringify(prefs)}
read_prefs() {
  if [ -e "$prefs" ]; then
    cat "$prefs"
  else
    echo '{"ControlURL": "https://controlplane.tailscale.com"}'
  fi
}
shift
case $1 in
  status)
    if [ -e "$starting" ]; then
      echo '{"BackendState": "Starting"}'
    else
      cat "$status"
    fi
    ;;
  debug)
    [ "$2" = prefs ] && read_prefs
    ;;
  up)
    hostname= tags= control=https://controlplane.tailscale.com reauth=
    for arg in "$@"; do
      case $arg in
        --hostname=*) hostname=$(cut -d= -f2- <<<"$arg") ;;
        --advertise-tags=*) tags=$(cut -d= -f2- <<<"$arg") ;;
        --login-server=*) control=$(cut -d= -f2- <<<"$arg") ;;
        --force-reauth) reauth=1 ;;
      esac
    done
    if [ -z "$reauth" ] && [ -e "$status" ] && [ "$(jq -r .BackendState "$status")" = Running ] &&
      [ "$(read_prefs | jq -r .ControlURL)" != "$control" ]; then
      echo "can't change --login-server without --force-reauth" >&2
      exit 1
    fi
    jq -n --arg url "$control" '{ControlURL: $url}' >"$prefs"
    jq -n --arg host "$hostname" --arg tags "$tags" \
      '{BackendState: "Running", Self: {HostName: $host, Tags: ($tags | split(",")), TailscaleIPs: ["100.64.0.9"], DNSName: "imp.tail1234.ts.net."}}' \
      >"$status"
    ;;
  down)
    jq '.BackendState = "Stopped"' "$status" >"$status.new"
    mv "$status.new" "$status"
    ;;
esac`,
  );

  return {
    bin: stub.bin,
    writeNode: (node) => {
      writeFileSync(status, JSON.stringify(node));
    },
    writePrefs: (nodePrefs) => {
      writeFileSync(prefs, JSON.stringify(nodePrefs));
    },
    holdStart: () => {
      writeFileSync(starting, '');
    },
    releaseStart: () => {
      rmSync(starting);
    },
    readNode: () => NodeSchema.parse(JSON.parse(readFileSync(status, 'utf8'))),
    readCalls: (verb) =>
      readFileSync(stub.calls, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('tailscale ') && line.split(' ')[2] === verb)
        .map((line) => line.split(' ').slice(2).join(' ')),
  };
}
