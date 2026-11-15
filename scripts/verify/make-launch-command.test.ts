import { expect, test } from 'bun:test';
import { makeLaunchCommand } from './make-launch-command.ts';

test.each(['local', 'local-kvm'])('it runs the command on %s', async (target) => {
  const command = makeLaunchCommand((name: string) => Promise.resolve(name));

  const answer = await command('wv-one', { target });

  expect(answer).toBe('wv-one');
});

test('it refuses the command on an attach target before it runs', () => {
  const command = makeLaunchCommand(() => Promise.reject(new Error('the command ran')));

  expect(command({}, { target: 'prod' })).rejects.toMatchObject({
    code: 'target-not-allowed',
  });
});
