import { WringerError } from '@wringer/core';
import type { MCPClient } from '@wringer/mcp';

// The doctor's `service-client` check: the target's service client trades its ID and secret for an
// access token, and lists the tools its scope allows with it.
export async function checkServiceClient(mcp: MCPClient): Promise<{ tools: number }> {
  const answer = await mcp.tools().catch((error: unknown) => {
    if (error instanceof WringerError) {
      throw new WringerError('check-failed', {
        message: `the service client did not sign in: ${error.message}`,
        hint: "Check that impd's service-token file holds the digest of the run's secret, and that its clients file names the client, then run `bun verify doctor` again.",
      });
    }

    throw error;
  });

  return { tools: answer.tools.length };
}
