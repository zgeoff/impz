import { runChecked } from '../../src/platform/process/run-command';
import type { CommandResult } from '../../src/platform/process/run-command';

type StubServiceConfig = Map<
  number,
  { readonly scheme: 'http' | 'https'; readonly target: string }
>;

interface StubTailscaleServeOptions {
  readonly tailnet?: string;
}

export function buildStubTailscaleServe(options: Readonly<StubTailscaleServeOptions> = {}) {
  const tailnet = options.tailnet ?? 'tail1234.ts.net';

  const nodePorts = new Set<number>();
  const services = new Map<string, StubServiceConfig>();

  const calls: (readonly string[])[] = [];
  const failures: string[] = [];

  const renderStatus = (): string => {
    const tcp = Object.fromEntries([...nodePorts].map((port) => [String(port), { HTTPS: true }]));

    const rendered = Object.fromEntries(
      [...services].map(([service, ports]) => {
        const host = service.replace(/^svc:/v, '');

        return [
          service,
          {
            TCP: Object.fromEntries(
              [...ports].map(([port, entry]) => [
                String(port),
                entry.scheme === 'https' ? { HTTPS: true } : { HTTP: true },
              ]),
            ),
            Web: Object.fromEntries(
              [...ports].map(([port, entry]) => [
                `${host}.${tailnet}:${String(port)}`,
                { Handlers: { '/': { Proxy: entry.target } } },
              ]),
            ),
          },
        ];
      }),
    );

    const status = {
      ...(nodePorts.size > 0 && { TCP: tcp }),
      ...(services.size > 0 && { Services: rendered }),
    };

    return `${JSON.stringify(status, null, 2)}\n`;
  };

  const runServe = (argv: readonly string[]): CommandResult => {
    const [binary, verb, ...rest] = argv;

    if (binary !== 'tailscale' || verb !== 'serve') {
      return { exitCode: 1, stdout: '', stderr: `unknown command: ${argv.join(' ')}` };
    }

    if (rest.join(' ') === 'status --json') {
      return { exitCode: 0, stdout: renderStatus(), stderr: '' };
    }

    if (rest[0] === 'clear' && rest.length === 2 && rest[1] !== undefined) {
      services.delete(rest[1]);

      return { exitCode: 0, stdout: '', stderr: '' };
    }

    const [serviceFlag = '', portFlag = '', target] = rest;
    const service = /^--service=(?<name>svc:.+)$/v.exec(serviceFlag)?.groups?.['name'];
    const port = /^--(?<scheme>https?)=(?<port>\d+)$/v.exec(portFlag)?.groups;

    if (service === undefined || port === undefined || target === undefined || rest.length !== 3) {
      return { exitCode: 1, stdout: '', stderr: `unknown command: ${argv.join(' ')}` };
    }

    const ports = services.get(service) ?? new Map();

    ports.set(Number(port['port']), {
      scheme: port['scheme'] === 'https' ? 'https' : 'http',
      target,
    });

    services.set(service, ports);

    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const run = (argv: readonly string[]): Promise<CommandResult> => {
    calls.push([...argv]);

    const failure = failures.shift();

    if (failure !== undefined) {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: failure });
    }

    return Promise.resolve(runServe(argv));
  };

  return {
    run,
    calls,
    runChecked: (argv: readonly string[]): Promise<string> => runChecked(argv, {}, run),

    holdPort: (port: number): void => {
      nodePorts.add(port);
    },

    failNext: (stderr: string): void => {
      failures.push(stderr);
    },
  };
}
