import { parseArgs } from 'node:util';

export interface StepArgument {
  readonly name: string;
  readonly choices?: readonly string[];
  readonly isOptional?: boolean;
}

export type StepCommand =
  | { readonly isValid: true; readonly values: readonly string[] }
  | { readonly isValid: false; readonly usage: string };

export function parseStepCommand(
  script: string,
  stepArguments: readonly StepArgument[],
  argv: readonly string[],
): StepCommand {
  const usage = `usage: ${script} ${stepArguments.map((argument) => formatStepArgument(argument)).join(' ')}`;

  const parsed = parseArgs({
    args: [...argv],
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  const hasFlag = parsed.tokens.some((token) => token.kind !== 'positional');
  const required = stepArguments.filter((argument) => argument.isOptional !== true).length;
  const values = parsed.positionals;

  const isOutsideChoices = values.some((value, index) => {
    const choices = stepArguments[index]?.choices;

    return choices !== undefined && !choices.includes(value);
  });

  const hasWrongCount = values.length < required || values.length > stepArguments.length;

  if (hasFlag || hasWrongCount || isOutsideChoices) {
    return { isValid: false, usage };
  }

  return { isValid: true, values };
}

function formatStepArgument(argument: StepArgument): string {
  const inner = argument.choices === undefined ? argument.name : argument.choices.join('|');

  return argument.isOptional === true ? `[${inner}]` : `<${inner}>`;
}
