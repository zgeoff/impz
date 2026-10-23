import { expect, mock, test } from 'bun:test';
import type { ImpEvent } from '@impz/api';
import { buildStubExecBackend } from '../../../testing/imps/build-stub-exec-backend';
import { buildStubAgentExecStream } from '../../../testing/vm/build-stub-agent-exec-stream';
import type { ApiAudit } from '../../platform/audit/api-audit';
import { createEventBus } from '../../platform/events/event-bus';
import { buildAuditedBackend } from './audited-backend';

test('it audits a terminal exec as a console, with what it failed with', () => {
  const failure = new Error('dev is stopped');

  const stub = buildStubExecBackend({ exec: failure });
  const record = mock<ApiAudit['record']>();

  const audited = buildAuditedBackend({
    backend: stub.backend,
    audit: { record },
    actor: { kind: 'dashboard', name: 'laptop' },
    events: createEventBus(),
    now: () => 5,
  });

  expect(audited.openExec('dev', { argv: ['bash'], tty: true })).rejects.toBe(failure);

  expect(record).toHaveBeenCalledExactlyOnceWith(
    {
      procedure: 'console',
      actor: { kind: 'dashboard', name: 'laptop' },
      impName: 'dev',
      startedAt: 5,
    },
    failure,
  );
});

test('it audits a plain exec as an exec, with no failure once it opens', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const record = mock<ApiAudit['record']>();

  const audited = buildAuditedBackend({
    backend: stub.backend,
    audit: { record },
    actor: { kind: 'dashboard', name: 'laptop' },
    events: createEventBus(),
    now: () => 5,
  });

  await audited.openExec('dev', { argv: ['ls'], tty: false });

  expect(record).toHaveBeenCalledExactlyOnceWith(
    {
      procedure: 'exec',
      actor: { kind: 'dashboard', name: 'laptop' },
      impName: 'dev',
      startedAt: 5,
    },
    null,
  );
});

test('it audits the tar tool as cp', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const record = mock<ApiAudit['record']>();

  const audited = buildAuditedBackend({
    backend: stub.backend,
    audit: { record },
    actor: { kind: 'dashboard', name: 'laptop' },
    events: createEventBus(),
    now: () => 5,
  });

  await audited.openExec('dev', { argv: ['imp-agent', 'tar'], tty: false }, 'cp');

  expect(record).toHaveBeenCalledExactlyOnceWith(
    {
      procedure: 'cp',
      actor: { kind: 'dashboard', name: 'laptop' },
      impName: 'dev',
      startedAt: 5,
    },
    null,
  );
});

test('it audits an attach as an attach', () => {
  const failure = new Error('no such session');

  const stub = buildStubExecBackend({ attach: failure });
  const record = mock<ApiAudit['record']>();

  const audited = buildAuditedBackend({
    backend: stub.backend,
    audit: { record },
    actor: { kind: 'dashboard', name: 'laptop' },
    events: createEventBus(),
    now: () => 5,
  });

  expect(audited.openAttach('dev', { session: 's1' })).rejects.toBe(failure);

  expect(record).toHaveBeenCalledExactlyOnceWith(
    {
      procedure: 'attach',
      actor: { kind: 'dashboard', name: 'laptop' },
      impName: 'dev',
      startedAt: 5,
    },
    failure,
  );
});

test('it audits an exec in the agent as exec-agent', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const record = mock<ApiAudit['record']>();

  const audited = buildAuditedBackend({
    backend: stub.backend,
    audit: { record },
    actor: { kind: 'token', name: 'admin' },
    events: createEventBus(),
    now: () => 5,
  });

  await audited.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec');

  expect(record).toHaveBeenCalledExactlyOnceWith(
    {
      procedure: 'exec-agent',
      actor: { kind: 'token', name: 'admin' },
      impName: 'dev',
      startedAt: 5,
    },
    null,
  );
});

test('it publishes an exec in the agent once the agent took it, naming only the command', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const bus = createEventBus();
  const events: ImpEvent[] = [];

  bus.subscribe((event) => {
    events.push(event);
  });

  const audited = buildAuditedBackend({
    backend: stub.backend,
    audit: { record: mock<ApiAudit['record']>() },
    actor: { kind: 'token', name: 'admin' },
    events: bus,
    now: () => 5,
  });

  await audited.openExec(
    'dev',
    { argv: ['sh', '-c', 'secret args'], tty: true, outer: true },
    'outer-exec',
  );

  expect(events).toStrictEqual([
    {
      // oxlint-disable-next-line id-length -- `v` is the event format's version field
      v: 1,
      at: new Date(5),
      ev: 'AgentExec',
      name: 'dev',
      actor: 'token',
      actorName: 'admin',
      tty: true,
      command: 'sh',
    },
  ]);
});

test('it publishes nothing for an exec in the agent that the agent refused', () => {
  const failure = new Error('AGENT_OUTDATED');

  const stub = buildStubExecBackend({ exec: failure });
  const bus = createEventBus();
  const events: ImpEvent[] = [];

  bus.subscribe((event) => {
    events.push(event);
  });

  const audited = buildAuditedBackend({
    backend: stub.backend,
    audit: { record: mock<ApiAudit['record']>() },
    actor: { kind: 'token', name: 'admin' },
    events: bus,
    now: () => 5,
  });

  expect(
    audited.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec'),
  ).rejects.toBe(failure);

  expect(events).toStrictEqual([]);
});

test('it publishes nothing for a plain exec', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const bus = createEventBus();
  const events: ImpEvent[] = [];

  bus.subscribe((event) => {
    events.push(event);
  });

  const audited = buildAuditedBackend({
    backend: stub.backend,
    audit: { record: mock<ApiAudit['record']>() },
    actor: { kind: 'token', name: 'admin' },
    events: bus,
    now: () => 5,
  });

  await audited.openExec('dev', { argv: ['ls'], tty: false });

  expect(events).toStrictEqual([]);
});
