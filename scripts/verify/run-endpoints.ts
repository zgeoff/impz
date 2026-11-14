import * as z from 'zod';

// The ready line of each target's app, which every driver config, action and check reads from the
// run's endpoints.
const runEndpointsSchema = z.object({
  // impd's API, and the `http` driver's endpoint
  web: z.url(),

  // the origin of impd's public MCP route; `/mcp` is the resource
  mcp: z.url(),
  configHome: z.string().min(1),
  bin: z.string().min(1),
  tokenFile: z.string().min(1),

  // why this machine cannot run the target, which the doctor's `host` check reports; empty when it
  // can, because the run's endpoints hold only strings
  blocked: z.string().default(''),
});

export type RunEndpoints = z.infer<typeof runEndpointsSchema>;

export function parseRunEndpoints(value: unknown): RunEndpoints {
  return runEndpointsSchema.parse(value);
}
