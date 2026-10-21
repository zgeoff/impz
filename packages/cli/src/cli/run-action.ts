import { MissingFeatureError, ORPCError } from '@impz/client';
import * as z from 'zod';
import { loadCliConfig } from '../config/cli-config';
import type { CliConfig } from '../config/cli-config';
import { createImpClient } from '../config/create-imp-client';
import type { ImpClient } from '../config/create-imp-client';
import type { ImpzExtension } from './impz-plugin';

const TOKEN_HINT =
  'unauthorized: set IMP_TOKEN to the token from <IMP_DATA_DIR>/token, or run impz login <url>';

// what oRPC puts in a BAD_REQUEST's data when the input fails its schema
const PathKeySchema = z.union([z.string(), z.number(), z.object({ key: z.unknown() })]);
const IssueSchema = z.object({ message: z.string(), path: z.array(PathKeySchema).optional() });
const ValidationDataSchema = z.object({ issues: z.array(IssueSchema) });

export async function runAction(
  impz: ImpzExtension,
  action: (client: ImpClient) => Promise<void>,
): Promise<void> {
  const config = loadCliConfig(impz.io.env, impz.host, impz.io.printError);

  try {
    await action(createImpClient(config));
  } catch (error) {
    throw toCallError(error, config);
  }
}

export function toCallError(error: unknown, config: CliConfig): unknown {
  if (error instanceof ORPCError && error.status === 401) {
    return new Error(formatUnauthorized(config), { cause: error });
  }

  return error;
}

export function formatError(error: unknown, config: CliConfig | null = null): string {
  if (error instanceof ORPCError) {
    if (error.status === 401) {
      return formatUnauthorized(config);
    }

    const code = String(error.code);
    const data: unknown = error.data;

    return `${code}: ${error.message}${formatIssues(code, data)}`;
  }

  if (error instanceof MissingFeatureError) {
    return `${error.message}. Upgrade impd, or use an older imp CLI`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

// impd puts the details of codes other than BAD_REQUEST in the message, such
// as RAM_BUDGET_EXCEEDED's numbers
function formatIssues(code: string, data: unknown): string {
  const validation = code === 'BAD_REQUEST' ? ValidationDataSchema.safeParse(data) : null;

  if (validation?.success !== true) {
    return '';
  }

  const issues = validation.data.issues.map((issue) => {
    const path = (issue.path ?? [])
      .map((key) => (typeof key === 'object' ? String(key.key) : String(key)))
      .join('.');

    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });

  return ` (${issues.join('; ')})`;
}

export function formatUnauthorized(config: CliConfig | null): string {
  if (config?.host === null || config?.host === undefined) {
    return TOKEN_HINT;
  }

  return `unauthorized: ${config.host} (${config.url}) refused the token; run impz login ${config.url} --name ${config.host}`;
}
