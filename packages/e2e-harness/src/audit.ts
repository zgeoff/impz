import * as z from 'zod';
import { runImp } from './imp-cli';

const CallSchema = z.object({
  procedure: z.string(),
  actor: z.string(),
  actorName: z.string().optional(),
  outcome: z.string(),
});

export type AuditCall = z.infer<typeof CallSchema>;

export function parseAuditCalls(stdout: string): AuditCall[] {
  return z.array(CallSchema).parse(JSON.parse(stdout));
}

export async function listAuditCalls(imp: string): Promise<AuditCall[]> {
  const stdout = await runImp('audit', '--kind', 'api', imp, '--json');

  return parseAuditCalls(stdout);
}
