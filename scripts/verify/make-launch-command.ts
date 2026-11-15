import { WringerError } from '@wringer/core';
import { LAUNCH_TARGETS } from './constants.ts';

interface CommandContext {
  readonly target: string;
}

// Wraps a repo command that reads the run's endpoints, which only a target that `up` starts has. A
// command takes no list of targets, as an action does, so on any other target the command refuses
// before it runs.
export function makeLaunchCommand<Args, Context extends CommandContext, Data>(
  run: (args: Args, ctx: Context) => Promise<Data>,
): (args: Args, ctx: Context) => Promise<Data> {
  return (args, ctx) =>
    LAUNCH_TARGETS.includes(ctx.target)
      ? run(args, ctx)
      : Promise.reject(
          new WringerError('target-not-allowed', {
            message: `The command runs on ${LAUNCH_TARGETS.join(' and ')} only, not on ${ctx.target}.`,
            hint: 'Run it on a target that `bun verify up` starts.',
          }),
        );
}
