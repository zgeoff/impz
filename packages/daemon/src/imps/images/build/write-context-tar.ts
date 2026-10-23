import { open } from 'node:fs/promises';
import { writeLocalEntries } from '@impz/local-tar';
import type { LocalEntry } from '@impz/local-tar';
import { getImpdLogger } from '../../../platform/process/get-impd-logger';

const NO_PROGRESS = { add: () => {} };

export async function writeContextTar(entries: readonly LocalEntry[], path: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);

  try {
    await writeLocalEntries(
      entries,
      async (chunk) => {
        await file.write(chunk);
      },
      NO_PROGRESS,
      (text) => {
        getImpdLogger('image').warning('image build context: {text}', { text });
      },
    );
  } finally {
    await file.close();
  }
}
