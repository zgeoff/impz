import { defineCommand, defineGroup } from '../cli/define-command';
import { UsageError } from '../cli/errors';
import { runAction } from '../cli/run-action';
import { formatJson } from '../output/format-output';

const jwksCommand = defineCommand({
  name: 'jwks',
  description:
    "Print impd's public identity keys as a JWKS document with its issuer and retire list, for a service to pin",
  args: {},
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const document = await client.identity.jwks();

      ctx.extensions.impz.io.print(formatJson(document));
    }),
});

const stageCommand = defineCommand({
  name: 'stage',
  description:
    'Stage the next identity key: impd signs with it from --at, then deletes the old private key; it has no cancel',
  args: {
    at: {
      type: 'string',
      description: 'the switch time, such as 2026-12-01T03:00Z',
      required: true,
    },
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const at = new Date(ctx.values.at);

      if (Number.isNaN(at.getTime())) {
        throw new UsageError(`--at: not a time: ${ctx.values.at} (try 2026-12-01T03:00Z)`);
      }

      const document = await client.identity.stageKey({ at });

      ctx.extensions.impz.io.print(formatJson(document));
    }),
});

const keyCommand = defineGroup({
  name: 'key',
  description: "Change impd's identity key",
  subCommands: { stage: stageCommand },
});

export const identityCommand = defineGroup({
  name: 'identity',
  description: 'The keys that sign the Imp-Identity token of the credential broker',
  subCommands: { jwks: jwksCommand, key: keyCommand },
});
