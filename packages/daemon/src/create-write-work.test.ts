import { expect, mock, test } from 'bun:test';
import { createWriteWork } from './create-write-work';

test('it logs work that rejects instead of leaving the rejection unhandled', async () => {
  const log = mock<(message: string) => void>();
  const writeWork = createWriteWork(log);

  writeWork.run(Promise.reject(new Error('driver has already been destroyed')));

  await writeWork.stop();

  expect(log).toHaveBeenCalledExactlyOnceWith(
    'impd: could not follow a database write: driver has already been destroyed',
  );
});
