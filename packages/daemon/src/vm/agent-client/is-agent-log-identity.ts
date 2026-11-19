import { ExecutionGenerationSchema, SessionNameSchema } from '@impz/api';
import * as z from 'zod';

// The guest is not trusted: a replaced agent can send anything, so each name impd uses in a path,
// a file name or a log is held to the form the real agent makes.
export const AgentGenerationSchema = ExecutionGenerationSchema;
export const AgentSessionNameSchema = SessionNameSchema;

// A guest without procfs reports an empty boot ID.
export const AgentBootIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/u);

const AgentLogIdentitySchema = z.object({
  generation: AgentGenerationSchema,
  session: AgentSessionNameSchema,
  bootId: AgentBootIdSchema,
});

type AgentLogIdentity = z.infer<typeof AgentLogIdentitySchema>;

export function isAgentLogIdentity(identity: Readonly<AgentLogIdentity>): boolean {
  return AgentLogIdentitySchema.safeParse(identity).success;
}
