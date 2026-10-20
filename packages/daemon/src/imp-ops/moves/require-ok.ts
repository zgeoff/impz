import { readJsonBody } from './read-json-body';

// the body of the target's answer; an answer that is not ok throws with
// its status and the target's error
export async function requireOk(response: Response, what: string): Promise<unknown> {
  const body = await readJsonBody(response);

  if (!response.ok) {
    const error =
      body !== null && typeof body === 'object' && 'error' in body ? String(body.error) : '';

    throw new Error(`${what}: the target answered ${String(response.status)} ${error}`.trim());
  }

  return body;
}
