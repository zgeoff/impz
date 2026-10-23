import { FILES_GUEST_DIR } from '@impz/api';
import { ImpdError } from '../../platform/errors/impd-error';
import { buildAgentOutdatedApiError } from '../../platform/errors/impd-errors';
import { sendFilesRemove, sendFilesWrite } from '../../vm/agent-client/file-requests';
import { isAgentError } from '../../vm/agent-client/is-agent-error';
import type { ImpRuntime } from '../imps/imp-runtime';

export interface FileApi {
  readonly writeFile: (
    name: string,
    path: string,
    content: string,
  ) => Promise<{ readonly path: string }>;
  readonly removeFile: (name: string, path: string) => Promise<{ readonly removed: boolean }>;
}

interface FileApiParts {
  readonly runtime: Pick<ImpRuntime, 'sendToAgent'>;
}

export function createFileApi(parts: FileApiParts): FileApi {
  const runtime = parts.runtime;

  return {
    writeFile: async (name, path, content) => {
      const data = new TextEncoder().encode(content);

      await runtime
        .sendToAgent(name, (vsockPath) => sendFilesWrite(vsockPath, path, data), 'files')
        .catch((error: unknown) => {
          throw toApiError(error);
        });

      return { path: `${FILES_GUEST_DIR}/${path}` };
    },

    removeFile: async (name, path) => {
      const removed = await runtime
        .sendToAgent(name, (vsockPath) => sendFilesRemove(vsockPath, path), 'files')
        .catch((error: unknown) => {
          throw toApiError(error);
        });

      return { removed };
    },
  };
}

function toApiError(error: unknown): unknown {
  if (isAgentError(error, 'BAD_REQUEST') || isAgentError(error, 'NO_SPACE')) {
    return new ImpdError('BAD_REQUEST', { message: error.detail });
  }

  if (isAgentError(error, 'AGENT_OUTDATED')) {
    return buildAgentOutdatedApiError(error.message);
  }

  return error;
}
