export interface SystemFileInfo {
  readonly guestKernel: { readonly version: string | null; readonly sha256: string };
  readonly systemDrive: { readonly sha256: string };
}

// every Linux kernel image carries a C-string banner such as "Linux version 6.1.188 (imp@imp) ..."
const BANNER = Buffer.from('Linux version ');

export function readKernelInfo(image: Uint8Array): SystemFileInfo['guestKernel'] {
  return { version: parseKernelVersion(image), sha256: deriveSha256(image) };
}

export async function deriveFileSha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');

  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }

  return hasher.digest('hex');
}

export function parseKernelVersion(image: Uint8Array): string | null {
  const start = Buffer.from(image.buffer, image.byteOffset, image.byteLength).indexOf(BANNER);

  if (start === -1) {
    return null;
  }

  const tail = Buffer.from(image.subarray(start + BANNER.length, start + BANNER.length + 64));
  const [text = ''] = tail.toString('latin1').split('\0');
  const match = /^\S+/u.exec(text);

  return match?.[0] ?? null;
}

function deriveSha256(data: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}
