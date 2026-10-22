import { parseServeStatus } from '../../host-net/net/tailscale-serve';
import type { ServedServices } from '../../host-net/net/tailscale-serve';
import { runChecked } from '../../platform/process/run-command';

export interface ServiceServe {
  readonly readServed: () => Promise<ServedServices>;

  readonly writeServe: (service: string, target: string) => Promise<void>;

  readonly clearServe: (service: string) => Promise<void>;
}

export function listServeEntries(target: string): readonly string[] {
  return [`443 ${target}`, `80 ${target}`];
}

export function createServiceServe(
  run: (argv: readonly string[]) => Promise<string> = runChecked,
): ServiceServe {
  return {
    readServed: async () => {
      const json = await run(['tailscale', 'serve', 'status', '--json']);

      return parseServeStatus(json).services;
    },
    writeServe: async (service, target) => {
      // --service implies --bg: the config persists in tailscaled's state
      await run(['tailscale', 'serve', `--service=${service}`, '--http=80', target]);
      await run(['tailscale', 'serve', `--service=${service}`, '--https=443', target]);
    },
    clearServe: async (service) => {
      await run(['tailscale', 'serve', 'clear', service]);
    },
  };
}
