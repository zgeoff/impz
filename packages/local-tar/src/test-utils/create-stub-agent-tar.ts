import tar from 'tar-stream';
import type { Header } from 'tar-stream';

export type StubTarEntry = Partial<Header> & Pick<Header, 'name'> & { readonly content?: string };

export async function createStubAgentTar(
  entries: readonly Readonly<StubTarEntry>[],
): Promise<Uint8Array> {
  const pack = tar.pack();

  for (const { content, ...header } of entries) {
    if (content === undefined) {
      pack.entry({ mode: 0o755, ...header });
    } else {
      pack.entry({ mode: 0o644, type: 'file', ...header }, content);
    }
  }

  pack.finalize();

  const chunks: Uint8Array[] = [];

  for await (const chunk of pack) {
    if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }

  return Buffer.concat(chunks);
}
