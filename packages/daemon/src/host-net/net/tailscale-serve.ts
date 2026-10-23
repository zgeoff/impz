import * as z from 'zod';
import { runCommand } from '../../platform/process/run-command';
import type { CommandRunner } from '../../platform/process/run-command';

const HandlerSchema = z.object({ Proxy: z.string().optional() });

const WebSchema = z.object({
  Handlers: z.record(z.string(), HandlerSchema).nullable().optional(),
});

const ServiceConfigSchema = z.object({
  Web: z.record(z.string(), WebSchema).nullable().optional(),
});

const ServeStatusSchema = z.object({
  TCP: z.record(z.string(), z.unknown()).optional(),
  Services: z.record(z.string(), ServiceConfigSchema).nullable().optional(),
});

export type ServedServices = ReadonlyMap<string, readonly string[]>;

export interface ServeStatus {
  readonly ports: readonly number[];

  readonly services: ServedServices;
}

export function parseServeStatus(json: string): ServeStatus {
  try {
    // tailscale prints nothing when there is no serve config
    const text = json.trim() === '' ? '{}' : json;
    const status = ServeStatusSchema.parse(JSON.parse(text));

    return {
      ports: Object.keys(status.TCP ?? {})
        .map(Number)
        .filter((port) => Number.isInteger(port)),
      services: new Map(
        Object.entries(status.Services ?? {}).map(([name, config]) => [
          name,
          Object.entries(config.Web ?? {}).flatMap(([hostPort, web]) => {
            const proxy = web.Handlers?.['/']?.Proxy;
            const port = hostPort.split(':').at(-1) ?? '';

            return proxy === undefined ? [] : [`${port} ${proxy}`];
          }),
        ]),
      ),
    };
  } catch {
    return { ports: [], services: new Map() };
  }
}

// tailscaled takes a serve port on the tailnet IP itself, so an impd listener
// on it never sees the traffic.
export async function readServePorts(run: CommandRunner = runCommand): Promise<readonly number[]> {
  try {
    const result = await run(['tailscale', 'serve', 'status', '--json']);

    return result.exitCode === 0 ? parseServeStatus(result.stdout).ports : [];
  } catch {
    return [];
  }
}
