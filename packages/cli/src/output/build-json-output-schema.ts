import { buildProtocolSchema } from '@impz/api';
import * as z from 'zod';

const CommandOutputSchema = z
  .object({
    procedure: z.string(),
    schema: z.record(z.string(), z.unknown()).readonly(),
  })
  .readonly();

export const JsonOutputSchemaSchema = z
  .object({ outputs: z.record(z.string(), CommandOutputSchema).readonly() })
  .readonly();

export type JsonOutputSchema = z.infer<typeof JsonOutputSchemaSchema>;

// other programs read these `--json` outputs: cloud's `db copy` and `info`,
// and hq's capacity reads
const COVERED_OUTPUTS = {
  info: 'system.info',
  'info <name>': 'imps.get',
  ls: 'imps.list',
  'db copy': 'system.copyDatabase',
} as const;

export function buildJsonOutputSchema(): JsonOutputSchema {
  const procedures = buildProtocolSchema().procedures;

  return {
    outputs: Object.fromEntries(
      Object.entries(COVERED_OUTPUTS).map(([command, procedure]) => {
        const answer = procedures[procedure];

        if (answer === undefined || answer.stream) {
          throw new Error(`impz ${command} --json prints ${procedure}, which is not one answer`);
        }

        return [command, { procedure, schema: answer.output }];
      }),
    ),
  };
}
