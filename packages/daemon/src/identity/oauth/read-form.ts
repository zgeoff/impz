import { readBodyText } from './read-body-text';

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
