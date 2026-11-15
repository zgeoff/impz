import { WringerError } from '@wringer/core';
import type { Endpoints } from '@wringer/core';
import { PROD_ORIGIN_ENV, PROD_SECRET_ENV } from './constants.ts';

const hint = `Set ${PROD_ORIGIN_ENV} to the deployed impd's IMP_MCP_PUBLIC_URL, and ${PROD_SECRET_ENV} to the read client's secret, on the \`attach\` command, as the verify skill's feature-mcp-reads.md says.`;

// The `prod` target's endpoints: `mcp`, the origin of the deployed impd's public MCP route, from the
// environment of the shell that runs `attach`.
export function parseProdEndpoints(env: Readonly<Record<string, string | undefined>>): Endpoints {
  const text = env[PROD_ORIGIN_ENV];

  if (text === undefined || text === '') {
    throw new WringerError('environment', { message: `${PROD_ORIGIN_ENV} is not set`, hint });
  }

  const url = URL.parse(text);

  if (url?.protocol !== 'https:' || url.origin !== text) {
    throw new WringerError('environment', {
      message: `${PROD_ORIGIN_ENV} is not a bare https origin, such as https://imp.example.com`,
      hint,
    });
  }

  return { mcp: url.origin };
}
