import * as z from 'zod';
import { runChecked } from '../../platform/process/run-command';

const HandlerSchema = z.object({ Proxy: z.string().optional() });

const WebSchema = z.object({
  Handlers: z.record(z.string(), HandlerSchema).nullable().optional(),
});

const ServiceConfigSchema = z.object({
  Web: z.record(z.string(), WebSchema).nullable().optional(),
});

const ServeStatusSchema = z.object({
  Services: z.record(z.string(), ServiceConfigSchema).nullable().optional(),
});

export type ServedServices = ReadonlyMap<string, readonly string[]>;

export interface ServiceServe {
  readonly readServed: () => Promise<ServedServices>;

  readonly writeServe: (service: string, target: string) => Promise<void>;

  readonly clearServe: (service: string) => Promise<void>;
}

/* @internal */
export function parseServedServices(json: string): ServedServices {
  try {
    const text = json.trim() === '' ? '{}' : json;
    const status = ServeStatusSchema.parse(JSON.parse(text));

    return new Map(
      Object.entries(status.Services ?? {}).map(([name, config]) => [
        name,
        Object.entries(config.Web ?? {}).flatMap(([hostPort, web]) => {
          const proxy = web.Handlers?.['/']?.Proxy;
          const port = hostPort.split(':').at(-1) ?? '';

          return proxy === undefined ? [] : [`${port} ${proxy}`];
        }),
      ]),
    );
  } catch {
    return new Map();
  }
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

      return parseServedServices(json);
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
