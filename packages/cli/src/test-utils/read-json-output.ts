import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { JsonOutputSchemaSchema } from '../output/build-json-output-schema';

export function readJsonOutput(command: string, stdout: string): z.ZodSafeParseResult<unknown> {
  const path = join(import.meta.dir, '..', '..', 'json-output-schema.json');
  const committed = JsonOutputSchemaSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const output = committed.outputs[command];

  if (output === undefined) {
    throw new Error(`no committed schema for impz ${command} --json`);
  }

  const schema = z.fromJSONSchema(output.schema);

  return schema.safeParse(JSON.parse(stdout));
}
