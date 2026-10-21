import type { CommandContext } from 'gunshi';

type VerbRunner = (operands: readonly string[]) => Promise<void>;

export function listOperands(ctx: Readonly<CommandContext<never>>): string[] {
  return ctx.positionals.slice(ctx.commandPath.length);
}

export async function dispatchVerb(
  operands: readonly string[],
  verbs: Readonly<Record<string, VerbRunner>>,
  runOwnForm: () => Promise<void>,
): Promise<void> {
  const [verb, ...rest] = operands;
  const runVerb = verb === undefined || !Object.hasOwn(verbs, verb) ? undefined : verbs[verb];

  await (runVerb === undefined ? runOwnForm() : runVerb(rest));
}
