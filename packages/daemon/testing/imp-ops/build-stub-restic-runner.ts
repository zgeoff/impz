import type { CommandResult } from '../../src/platform/process/run-command';

export function buildStubResticRunner(results: readonly CommandResult[] = []) {
  const argvs: string[] = [];
  const envs: Readonly<Record<string, string>>[] = [];
  const queued = [...results];

  const run = (
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
  ): Promise<CommandResult> => {
    argvs.push(argv.join(' '));
    envs.push(env);

    return Promise.resolve(queued.shift() ?? { exitCode: 0, stdout: '', stderr: '' });
  };

  return { run, argvs, envs };
}
