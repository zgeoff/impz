import tar from 'tar-stream';
import type { Header } from 'tar-stream';

export type StubTarEntry = Partial<Header> & {
  readonly name: string;
  readonly content?: string;
};

export async function createStubTar(entries: readonly StubTarEntry[]): Promise<Uint8Array> {
  const pack = tar.pack();

  for (const { content, ...header } of entries) {
    pack.entry(header, content ?? '');
  }

  pack.finalize();

  const chunks: Uint8Array[] = [];

  for await (const chunk of pack) {
    if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }

  return new Uint8Array(Bun.concatArrayBuffers(chunks));
}
