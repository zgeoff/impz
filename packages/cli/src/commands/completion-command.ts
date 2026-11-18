import { choice, positional } from 'gunshi/combinators';
import { defineCommand } from '../cli/define-command';
import { SHELLS, readCompletionTree, renderCompletion } from '../cli/read-completion-tree';

export const completionCommand = defineCommand({
  name: 'completion',
  description: 'Print the shell completion script (bash, zsh or fish)',
  args: { shell: positional(choice(SHELLS, { description: 'bash, zsh or fish', required: true })) },
  run: async (ctx) => {
    const commandTree = await import('../cli/main-command');
    const tree = await readCompletionTree(commandTree.mainCommand);

    ctx.extensions.impz.io.writeOut(renderCompletion(ctx.values.shell, tree));
  },
});
