import type { CommandResult } from './instance';

// A git hook exports these, GIT_DIR above all, and a git child that inherits
// them works on that repository whatever its -C says.
export const GIT_REPO_ENV_VARS: readonly string[] = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];

export function createGitFreeEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const free: Record<string, string> = {};

  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !GIT_REPO_ENV_VARS.includes(name)) {
      free[name] = value;
    }
  }

  return free;
}

export interface GitCommandOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export async function runGitCommand(
  argv: readonly string[],
  options: Readonly<GitCommandOptions> = {},
): Promise<CommandResult> {
  const subprocess = Bun.spawn([...argv], {
    stdin: options.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...createGitFreeEnv(process.env), ...options.env },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { exitCode, stdout, stderr };
}

export async function runGitChecked(argv: readonly string[]): Promise<string> {
  const result = await runGitCommand(argv);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return result.stdout;
}
