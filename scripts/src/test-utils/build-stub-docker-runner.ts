export interface StubContainer {
  readonly name: string;
  readonly labels?: Readonly<Record<string, string>>;
}

interface StubCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface StubDockerRunner {
  readonly runCommand: (argv: readonly string[]) => Promise<StubCommandResult>;
  readonly runChecked: (argv: readonly string[]) => Promise<string>;
  readonly listContainers: () => readonly string[];
}

const LABEL_FORMAT = /^\{\{index \.Config\.Labels "(?<key>[^"]+)"\}\}$/v;

// Docker's own answers: inspect prints an empty line for a missing label and
// fails with "no such object" for a missing container; rm -f prints each
// container it removed and passes over a missing one with exit 0.
export function buildStubDockerRunner(containers: readonly StubContainer[]): StubDockerRunner {
  const running = new Map(containers.map((container) => [container.name, container]));

  return {
    runCommand: (argv) => {
      const [command, verb, flag, format = '', name = '', ...rest] = argv;
      const key = LABEL_FORMAT.exec(format)?.groups?.['key'];

      if (
        command !== 'docker' ||
        verb !== 'inspect' ||
        flag !== '--format' ||
        key === undefined ||
        rest.length > 0
      ) {
        return Promise.reject(
          new Error(`${argv.join(' ')}: the stub runs only docker inspect of one label`),
        );
      }

      const container = running.get(name);

      if (container === undefined) {
        return Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr: `error: no such object: ${name}\n`,
        });
      }

      return Promise.resolve({
        exitCode: 0,
        stdout: `${container.labels?.[key] ?? ''}\n`,
        stderr: '',
      });
    },
    runChecked: (argv) => {
      const [command, verb, flag, ...names] = argv;

      if (command !== 'docker' || verb !== 'rm' || flag !== '-f') {
        return Promise.reject(new Error(`${argv.join(' ')}: the stub runs only docker rm -f`));
      }

      const removed = names.filter((name) => running.delete(name));

      return Promise.resolve(removed.map((name) => `${name}\n`).join(''));
    },
    listContainers: () => [...running.keys()],
  };
}
