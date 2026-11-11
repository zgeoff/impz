// Not Buffer, which a browser or a worker may not have.
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = text
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(text.length / 4) * 4, '=');

    return Uint8Array.from(atob(padded), (character) => character.codePointAt(0) ?? 0);
  } catch {
    return null;
  }
}
