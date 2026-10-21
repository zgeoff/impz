import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { createStubBin } from './create-stub-bin';

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

export interface StubTailscale {
  readonly bin: string;
  readonly writeNode: (node: StubTailscaleNode) => void;

  // Until the start is released, status reports Starting whatever the node says.
  readonly holdStart: () => void;
  readonly releaseStart: () => void;

  readonly readNode: () => StubTailscaleNode;
  readonly readCalls: (verb: string) => readonly string[];
}

export function createStubTailscale(directory: string): StubTailscale {
  const status = join(directory, 'tailscale-status.json');
  const starting = join(directory, 'tailscale-starting');

  const stub = createStubBin(
    directory,
    'tailscale',
    String.raw`status=${JSON.stringify(status)}
starting=${JSON.stringify(starting)}
shift
case $1 in
  status)
    if [ -e "$starting" ]; then
      echo '{"BackendState": "Starting"}'
    else
      cat "$status"
    fi
    ;;
  up)
    hostname= tags=
    for arg in "$@"; do
      case $arg in
        --hostname=*) hostname=$(cut -d= -f2- <<<"$arg") ;;
        --advertise-tags=*) tags=$(cut -d= -f2- <<<"$arg") ;;
      esac
    done
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
