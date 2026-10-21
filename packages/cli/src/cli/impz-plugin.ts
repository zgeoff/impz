import { hasPriorityValidationError, plugin } from 'gunshi/plugin';
import type { CommandContext } from 'gunshi/plugin';
import { checkHostName } from '../config/host-store';
import type { CommandIO } from './command-io';
import { CommandLineError } from './errors';
import { renderUsage } from './render-usage';

export interface ImpzExtension {
  readonly host: string | null;
  readonly io: CommandIO;
}

export function buildImpzPlugin(io: CommandIO) {
  return plugin({
    id: 'impz',
    setup: (ctx) => {
      ctx.addGlobalOption('help', {
        type: 'boolean',
        short: 'h',
        description: 'Display this help message',
      });

      ctx.addGlobalOption('version', { type: 'boolean', description: 'Display this version' });

      ctx.addGlobalOption('host', {
        type: 'string',
        description: 'saved host to call (see impz host ls)',
      });

      ctx.decorateCommand((run) => (command) => {
        if (hasPriorityValidationError(command.validationError)) {
          throw toCommandLineError(command);
        }

        if (command.values['version'] === true) {
          return command.env.version;
        }

        if (command.values['help'] === true) {
          return renderUsage(command);
        }

        if (command.validationError !== undefined) {
          throw toCommandLineError(command);
        }

        return run(command);
      });
    },
    extension: (ctx): ImpzExtension => {
      const host: unknown = ctx.values['host'];

      return { host: typeof host === 'string' ? checkHostName(host) : null, io };
    },
  });
}

function toCommandLineError(ctx: Readonly<CommandContext>): CommandLineError {
  return new CommandLineError(
    ctx.commandPath.join(' '),
    ctx.validationError ?? new AggregateError([], 'refused'),
  );
}
