import { readBodyText } from './read-body-text';

// a urlencoded form of at most `maxBytes`; null for anything else
export async function readForm(
  request: Request,
  maxBytes: number,
): Promise<URLSearchParams | null> {
  const type = request.headers.get('content-type') ?? '';

  if (!type.startsWith('application/x-www-form-urlencoded')) {
    return null;
  }

  const text = await readBodyText(request, maxBytes);

  return text === null ? null : new URLSearchParams(text);
}
