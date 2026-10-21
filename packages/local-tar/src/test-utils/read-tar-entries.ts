import tar from 'tar-stream';
import type { Header } from 'tar-stream';

// tar-stream's types say a string where an entry with no link target has
// null, and leave out the offset that extract adds.
type ExtractedHeader = Omit<Header, 'linkname'> & {
  readonly linkname: unknown;
  readonly byteOffset?: unknown;
};

export interface TarEntry {
  readonly header: ExtractedHeader;
  readonly content: string;
}

export async function readTarEntries(bytes: Uint8Array): Promise<TarEntry[]> {
  const extract = tar.extract();
  const entries: TarEntry[] = [];

  extract.end(bytes);

  for await (const entry of extract) {
    const chunks: Uint8Array[] = [];

    for await (const chunk of entry) {
      if (chunk instanceof Uint8Array) {
        chunks.push(chunk);
      }
    }

    entries.push({
      header: { ...entry.header },
      content: new TextDecoder().decode(Bun.concatArrayBuffers(chunks)),
    });
  }

  return entries;
}
