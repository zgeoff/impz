export interface StubDockerRunner {
  readonly runChecked: (argv: readonly string[]) => Promise<string>;
  readonly listContainers: () => readonly string[];
}

// docker rm -f prints each container it removed and passes over a missing one
// with exit 0.
export function buildStubDockerRunner(containers: readonly string[]): StubDockerRunner {
  const running = new Set(containers);

  return {
    runChecked: (argv) => {
      const [command, verb, flag, ...names] = argv;

      if (command !== 'docker' || verb !== 'rm' || flag !== '-f') {
        return Promise.reject(new Error(`${argv.join(' ')}: the stub runs only docker rm -f`));
      }

      const removed = names.filter((name) => running.delete(name));

      return Promise.resolve(removed.map((name) => `${name}\n`).join(''));
    },
    listContainers: () => [...running],
  };
}
