import { existsSync } from 'node:fs';

export function updateReadOnly(stack: Readonly<DisposableStack>, path: string): () => void {
  // Root writes past any file mode, so only chattr +i locks a tree against root.
  const isRoot = process.getuid?.() === 0;
  const lock = isRoot ? buildChattrArgv(path, '+i') : ['chmod', '-R', 'a-w', path];
  const unlock = isRoot ? buildChattrArgv(path, '-i') : ['chmod', '-R', 'u+w', path];

  runChecked(lock);

  const updateWritable = () => {
    runChecked(unlock);
  };

  stack.defer(() => {
    if (existsSync(path)) {
      updateWritable();
    }
  });

  return updateWritable;
}

function buildChattrArgv(path: string, flag: string): readonly string[] {
  // chattr refuses a symlink, which holds no flags.
  return ['find', path, '!', '-type', 'l', '-exec', 'chattr', flag, '{}', '+'];
}

function runChecked(argv: readonly string[]): void {
  const result = Bun.spawnSync([...argv], { stderr: 'pipe' });

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
}
