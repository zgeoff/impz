import assert from 'node:assert/strict';
import { CLIENT_VERSION, ExecError, createImpClient, openExecSession } from '@impz/client';
import type { ExecOutcome, ExecSessionOptions } from '@impz/client';

const [expectedVersion = '', impdJson = '{}'] = process.argv.slice(2);
const impd = parseImpd(impdJson);
const imp = createImpClient({ url: impd.url, token: impd.token });

const decoder = new TextDecoder();

const CHECKS: readonly (readonly [string, () => Promise<void>])[] = [
  ['the version', checkVersion],
  ['system.info', checkServerInfo],
  ['a run with stdin', checkRun],
  ['an exec that closes', checkExecClose],
  ['a console with a resize and a key', checkConsole],
  ['impd under a path prefix', checkPrefix],
  ['a bad token', checkBadToken],
  ['a used exec ticket', checkUsedTicket],
  ['a closed port', checkClosedPort],
  ['an abort during the ticket call and the connect', checkAbort],
];

const DEADLINE_MS = 30_000;

process.on('unhandledRejection', (error) => {
  console.error('unhandled rejection:', error);
  process.exit(1);
});

const deadline = setTimeout(() => {
  console.error(`the smoke took more than ${String(DEADLINE_MS)} ms`);
  process.exit(1);
}, DEADLINE_MS);

for (const [name, check] of CHECKS) {
  await check();

  console.log(`ok ${name}`);
}

clearTimeout(deadline);

function parseImpd(json: string): Record<'url' | 'prefixedUrl' | 'closedUrl' | 'token', string> {
  const parsed: unknown = JSON.parse(json);

  assert.ok(typeof parsed === 'object' && parsed !== null);

  const getValue = (key: string): string => {
    const value: unknown = Reflect.get(parsed, key);

    assert.equal(typeof value, 'string', `run-stub-impd's ${key}`);

    return String(value);
  };

  return {
    url: getValue('url'),
    prefixedUrl: getValue('prefixedUrl'),
    closedUrl: getValue('closedUrl'),
    token: getValue('token'),
  };
}

function checkVersion(): Promise<void> {
  assert.equal(CLIENT_VERSION, expectedVersion);

  return Promise.resolve();
}

async function checkServerInfo(): Promise<void> {
  const check = await imp.checkServer();

  assert.equal(check.compatible, true, `impd ${check.serverVersion}`);
}

async function checkRun(): Promise<void> {
  const result = await imp.run('smoke', ['cat'], { stdin: 'ping' });

  assert.equal(result.code, 0);
  assert.equal(decoder.decode(result.stdout), 'ping');
}

async function checkExecClose(): Promise<void> {
  const handle = await imp.openExec('smoke', ['cat']);

  await handle.started;

  handle.close();

  await assert.rejects(handle.exit, makeExecErrorCheck('CLOSED'));
}

async function checkConsole(): Promise<void> {
  const shell = await imp.openConsole('smoke', { cols: 80, rows: 24 });

  await shell.started;

  shell.resize(100, 30);

  await shell.write('hi\n');

  const output = await readUntil(shell.stdout, ['tty 80x24', 'resize 100x30', 'hi']);

  assert.ok(output.includes('hi'));
  shell.sendSignal('SIGINT');

  const exit = await shell.exit;

  assert.deepEqual(exit, { code: null, signal: 'SIGINT' });
}

async function checkPrefix(): Promise<void> {
  const prefixed = createImpClient({ url: impd.prefixedUrl, token: impd.token });

  const check = await prefixed.checkServer();

  assert.equal(check.compatible, true);

  const result = await prefixed.run('smoke', ['cat'], { stdin: 'prefixed' });

  assert.equal(decoder.decode(result.stdout), 'prefixed');
}

async function checkBadToken(): Promise<void> {
  const wrong = createImpClient({ url: impd.url, token: 'not-the-token' });

  await assert.rejects(wrong.openExec('smoke', ['cat']), makeCodeCheck('UNAUTHORIZED'));

  // Bun reports a refused upgrade with no HTTP status.
  const outcome = await openRawSession(impd.url, 'not-the-token');

  assert.equal(outcome.kind, 'unauthorized');
}

// Node reports a refused upgrade with an error and no close.
async function checkUsedTicket(): Promise<void> {
  const issued = await imp.exec.ticket({ name: 'smoke' });

  const ticket = issued.ticket;
  const started = Promise.withResolvers<null>();

  const first = openExecSession({
    ...buildRawSession(impd.url, impd.token),
    ticket,
    onStarted: () => {
      started.resolve(null);
    },
  });

  await started.promise;

  first.stop();

  const outcome = await openRawSession(impd.url, impd.token, ticket);

  assert.deepEqual(outcome, { kind: 'unauthorized', ticketRefused: true });
}

async function checkClosedPort(): Promise<void> {
  const closed = createImpClient({ url: impd.closedUrl, token: impd.token });

  await assert.rejects(closed.checkServer());

  const outcome = await openRawSession(impd.closedUrl, impd.token);

  assert.equal(outcome.kind, 'unreachable');
}

async function checkAbort(): Promise<void> {
  const controller = new AbortController();

  const sendAbortingRequest = (request: Request) => {
    controller.abort();

    return fetch(request);
  };

  const aborting = createImpClient({
    url: impd.url,
    token: impd.token,
    fetch: sendAbortingRequest,
  });

  const opened = aborting.openExec('smoke', ['cat'], { signal: controller.signal });

  await assert.rejects(opened, isAbortError);

  const connecting = new AbortController();

  const handle = await imp.openExec('smoke', ['cat'], { signal: connecting.signal });

  connecting.abort();

  await assert.rejects(handle.started, isAbortError);
  await assert.rejects(handle.exit, isAbortError);
}

function isAbortError(error: unknown): boolean {
  assert.ok(error instanceof Error, String(error));
  assert.equal(error.name, 'AbortError', error.message);

  return true;
}

function openRawSession(url: string, token: string, ticket?: string): Promise<ExecOutcome> {
  const session = openExecSession({
    ...buildRawSession(url, token),
    ...(ticket !== undefined && { ticket }),
  });

  return session.outcome;
}

function buildRawSession(url: string, token: string): ExecSessionOptions {
  return {
    baseUrl: url,
    token,
    start: { name: 'smoke', argv: ['cat'], tty: false },
    onStarted: () => {
      assert.fail('a refused socket started');
    },
    onOutput: () => {},
    connect: (socketUrl) => new WebSocket(socketUrl),
  };
}

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  wanted: readonly string[],
): Promise<string> {
  const reader = stream.getReader();
  let text = '';

  while (!wanted.every((part) => text.includes(part))) {
    const chunk = await reader.read();

    assert.equal(chunk.done, false, `the stream ended before ${JSON.stringify(wanted)}: ${text}`);

    text += decoder.decode(chunk.value);
  }

  reader.releaseLock();

  return text;
}

function makeCodeCheck(code: string): (error: unknown) => boolean {
  return (error) => {
    const actual: unknown =
      typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;

    assert.equal(actual, code, String(error));

    return true;
  };
}

function makeExecErrorCheck(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof ExecError, String(error));

    return makeCodeCheck(code)(error);
  };
}
