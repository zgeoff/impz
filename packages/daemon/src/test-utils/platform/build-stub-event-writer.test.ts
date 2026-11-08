import { expect, test } from 'bun:test';
import { buildStubEventWriter } from './build-stub-event-writer';

test('it keeps each written event with its time, in order', async () => {
  const writer = buildStubEventWriter();

  await writer.write(
    {
      ev: 'AgentExec',
      name: 'quiet-otter',
      actor: 'token',
      actorName: 'ci',
      tty: false,
      command: 'ls',
    },
    1_800_000_000_000,
  );

  await writer.write(
    {
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'quiet-otter',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
    },
    1_800_000_001_000,
  );

  expect(writer.written).toStrictEqual([
    {
      ev: 'AgentExec',
      name: 'quiet-otter',
      actor: 'token',
      actorName: 'ci',
      tty: false,
      command: 'ls',
      at: 1_800_000_000_000,
    },
    {
      ev: 'GovernorDecision',
      decision: 'admitted',
      name: 'quiet-otter',
      trigger: 'wake',
      usedMib: 512,
      budgetMib: 4096,
      at: 1_800_000_001_000,
    },
  ]);
});
