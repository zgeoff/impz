import { expect, test } from 'bun:test';
import { buildMockImp } from '@impz/api/test-utils/build-mock-imp';
import { toApiCheckpoint } from '../platform/db/checkpoints';
import { buildMockCheckpointRecord } from '../test-utils/imp-ops/build-mock-checkpoint-record';
import { buildMockImpRecord } from '../test-utils/imps/build-mock-imp-record';
import { readApiEvent } from './read-api-event';

test('it presents an added imp as created, through the presenter', async () => {
  const presented = buildMockImp({ name: 'tidy-heron' });

  const event = await readApiEvent(
    { ev: 'ImpAdded', imp: buildMockImpRecord(), seq: 4, at: new Date(1_800_000_000_000) },
    () => Promise.resolve(presented),
  );

  expect(event).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: 1,
    at: new Date(1_800_000_000_000),
    ev: 'ImpAdded',
    reason: 'created',
    imp: presented,
  });
});

test('it keeps a change’s reason and detail', async () => {
  const presented = buildMockImp({ name: 'tidy-heron' });

  const event = await readApiEvent(
    {
      ev: 'ImpChanged',
      imp: buildMockImpRecord(),
      reason: 'booted',
      detail: { durationMs: 900 },
      seq: 4,
      at: new Date(1_800_000_000_000),
    },
    () => Promise.resolve(presented),
  );

  expect(event).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: 1,
    at: new Date(1_800_000_000_000),
    ev: 'ImpChanged',
    reason: 'booted',
    imp: presented,
    detail: { durationMs: 900 },
  });
});

test('it presents a removed imp', async () => {
  const presented = buildMockImp({ name: 'tidy-heron' });

  const event = await readApiEvent(
    { ev: 'ImpRemoved', imp: buildMockImpRecord(), seq: 4, at: new Date(1_800_000_000_000) },
    () => Promise.resolve(presented),
  );

  expect(event).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: 1,
    at: new Date(1_800_000_000_000),
    ev: 'ImpRemoved',
    imp: presented,
  });
});

test('it presents a checkpoint in the API’s shape, with no presenter call', async () => {
  const checkpoint = buildMockCheckpointRecord();

  const event = await readApiEvent(
    {
      ev: 'CheckpointAdded',
      name: 'tidy-heron',
      checkpoint,
      seq: 4,
      at: new Date(1_800_000_000_000),
    },
    () => Promise.reject(new Error('a checkpoint event presents no imp')),
  );

  expect(event).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: 1,
    at: new Date(1_800_000_000_000),
    ev: 'CheckpointAdded',
    name: 'tidy-heron',
    checkpoint: toApiCheckpoint(checkpoint),
  });
});

test('it sends a decision of the RAM governor as written, without its seq', async () => {
  const event = await readApiEvent(
    {
      ev: 'GovernorDecision',
      decision: 'refused',
      name: 'tidy-heron',
      trigger: 'wake',
      usedMib: 3900,
      budgetMib: 4096,
      neededMib: 200,
      seq: 4,
      at: new Date(1_800_000_000_000),
    },
    () => Promise.reject(new Error('a decision presents no imp')),
  );

  expect(event).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: 1,
    at: new Date(1_800_000_000_000),
    ev: 'GovernorDecision',
    decision: 'refused',
    name: 'tidy-heron',
    trigger: 'wake',
    usedMib: 3900,
    budgetMib: 4096,
    neededMib: 200,
  });
});

test('it sends an exec in an agent as written, without its seq', async () => {
  const event = await readApiEvent(
    {
      ev: 'AgentExec',
      name: 'tidy-heron',
      actor: 'token',
      actorName: 'ci',
      tty: false,
      command: 'ls',
      seq: 4,
      at: new Date(1_800_000_000_000),
    },
    () => Promise.reject(new Error('an exec presents no imp')),
  );

  expect(event).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: 1,
    at: new Date(1_800_000_000_000),
    ev: 'AgentExec',
    name: 'tidy-heron',
    actor: 'token',
    actorName: 'ci',
    tty: false,
    command: 'ls',
  });
});
