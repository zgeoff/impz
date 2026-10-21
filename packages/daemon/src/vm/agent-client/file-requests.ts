import { handleUnknownOp } from './agent-outdated';
import { FilesRemovedSchema, OKSchema } from './agent-protocol';
import { sendAgentRequest } from './agent-requests';
import { decodeAgentMessage } from './decode-agent-message';

export async function sendFilesWrite(
  vsockPath: string,
  path: string,
  data: Uint8Array,
): Promise<void> {
  const response = await sendAgentRequest(vsockPath, { op: 'files.write', path, data }).catch(
    handleUnknownOp('files'),
  );

  decodeAgentMessage(OKSchema, response);
}

export async function sendFilesRemove(vsockPath: string, path: string): Promise<boolean> {
  const response = await sendAgentRequest(vsockPath, { op: 'files.remove', path }).catch(
    handleUnknownOp('files'),
  );

  return decodeAgentMessage(FilesRemovedSchema, response).removed;
}
