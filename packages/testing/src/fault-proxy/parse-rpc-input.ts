import { isRecord } from './is-record';

// the input of an oRPC call: the `json` member of a JSON body, and undefined for a body of another kind
export function parseRpcInput(contentType: string | null, body: Uint8Array): unknown {
  if (!(contentType ?? '').startsWith('application/json') || body.byteLength === 0) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));

    return isRecord(parsed) ? parsed['json'] : undefined;
  } catch {
    return undefined;
  }
}
