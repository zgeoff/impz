import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { buildStubZfs } from './build-stub-zfs';

test('#buildStubZfs receives a full stream as a new dataset with its snapshot', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  const send = source.streams.readFrom(['zfs', 'send', 'tank/imp/a@one']);

  await target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@one'], send.stdout);

  expect(target.listDatasets()).toStrictEqual(['cold/imp', 'cold/imp/a']);
  expect(target.listSnapshots()).toStrictEqual(['cold/imp/a@one']);
  expect(target.readOrigin('cold/imp/a')).toBeNull();
});

test('#buildStubZfs receives an incremental stream onto the snapshot it is based on', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  await target.streams.writeTo(
    ['zfs', 'recv', '-u', 'cold/imp/a@one'],
    source.streams.readFrom(['zfs', 'send', 'tank/imp/a@one']).stdout,
  );

  await source.run(['zfs', 'snapshot', 'tank/imp/a@two']);

  const send = source.streams.readFrom(['zfs', 'send', '-i', 'tank/imp/a@one', 'tank/imp/a@two']);

  await target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@two'], send.stdout);

  expect(target.listSnapshots()).toStrictEqual(['cold/imp/a@one', 'cold/imp/a@two']);
});

test('#buildStubZfs receives a clone stream as a clone of the origin given', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/image']);
  await source.run(['zfs', 'snapshot', 'tank/imp/image@base']);
  await source.run(['zfs', 'clone', 'tank/imp/image@base', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@cp']);

  await target.streams.writeTo(
    ['zfs', 'recv', '-u', 'cold/imp/image@base'],
    source.streams.readFrom(['zfs', 'send', 'tank/imp/image@base']).stdout,
  );

  const send = source.streams.readFrom([
    'zfs',
    'send',
    '-i',
    'tank/imp/image@base',
    'tank/imp/a@cp',
  ]);

  await target.streams.writeTo(
    ['zfs', 'recv', '-u', '-o', 'origin=cold/imp/image@base', 'cold/imp/a@cp'],
    send.stdout,
  );

  expect(target.readOrigin('cold/imp/a')).toBe('cold/imp/image@base');
  expect(target.listSnapshots()).toStrictEqual(['cold/imp/a@cp', 'cold/imp/image@base']);
});

test('#buildStubZfs refuses a full stream onto a dataset that exists', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@one']);
  await target.run(['zfs', 'create', 'cold/imp/a']);

  const send = source.streams.readFrom(['zfs', 'send', 'tank/imp/a@one']);
  const received = target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@one'], send.stdout);

  expect(received).rejects.toThrowWithMessage(
    Error,
    "cannot receive new filesystem stream: destination 'cold/imp/a' exists",
  );
});

test('#buildStubZfs refuses an incremental stream whose base is not the latest snapshot', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@one']);

  await target.streams.writeTo(
    ['zfs', 'recv', '-u', 'cold/imp/a@one'],
    source.streams.readFrom(['zfs', 'send', 'tank/imp/a@one']).stdout,
  );

  await target.run(['zfs', 'snapshot', 'cold/imp/a@local']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@two']);

  const send = source.streams.readFrom(['zfs', 'send', '-i', 'tank/imp/a@one', 'tank/imp/a@two']);
  const received = target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@two'], send.stdout);

  expect(received).rejects.toThrowWithMessage(
    Error,
    'cannot receive incremental stream: most recent snapshot of cold/imp/a does not match incremental source',
  );
});

test('#buildStubZfs refuses a clone stream without an origin', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/image']);
  await source.run(['zfs', 'snapshot', 'tank/imp/image@base']);
  await source.run(['zfs', 'clone', 'tank/imp/image@base', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@cp']);

  await target.streams.writeTo(
    ['zfs', 'recv', '-u', 'cold/imp/image@base'],
    source.streams.readFrom(['zfs', 'send', 'tank/imp/image@base']).stdout,
  );

  const send = source.streams.readFrom([
    'zfs',
    'send',
    '-i',
    'tank/imp/image@base',
    'tank/imp/a@cp',
  ]);

  const received = target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@cp'], send.stdout);

  expect(received).rejects.toThrowWithMessage(
    Error,
    'cannot receive: local origin for clone cold/imp/a does not exist',
  );
});

test('#buildStubZfs refuses a clone stream whose origin is not the stream base', async () => {
  const source = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  await source.run(['zfs', 'create', 'tank/imp/image']);
  await source.run(['zfs', 'snapshot', 'tank/imp/image@base']);
  await source.run(['zfs', 'clone', 'tank/imp/image@base', 'tank/imp/a']);
  await source.run(['zfs', 'snapshot', 'tank/imp/a@cp']);
  await target.run(['zfs', 'create', 'cold/imp/image']);
  await target.run(['zfs', 'snapshot', 'cold/imp/image@base']);

  const send = source.streams.readFrom([
    'zfs',
    'send',
    '-i',
    'tank/imp/image@base',
    'tank/imp/a@cp',
  ]);

  const received = target.streams.writeTo(
    ['zfs', 'recv', '-u', '-o', 'origin=cold/imp/image@base', 'cold/imp/a@cp'],
    send.stdout,
  );

  expect(received).rejects.toThrowWithMessage(
    Error,
    'cannot receive: local origin for clone cold/imp/a does not exist',
  );
});

test('#buildStubZfs refuses to send a snapshot that does not exist', () => {
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: '/var/lib/imp' });

  expect(() => fake.streams.readFrom(['zfs', 'send', 'tank/imp@one'])).toThrowWithMessage(
    Error,
    'fake zfs: zfs send tank/imp@one: no such snapshot',
  );
});

test('#buildStubZfs receives nothing from a stream that ends before its end record', () => {
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  const input = new Response('{"guid":"0199a","baseG').body;

  invariant(input);

  const received = target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@one'], input);

  expect(received).rejects.toThrowWithMessage(Error, 'cannot receive: the stream ended early');
  expect(target.listDatasets()).toStrictEqual(['cold/imp']);
});

test('#buildStubZfs commits a receive once the end record is in, though the input fails after', () => {
  const target = buildStubZfs({ root: 'cold/imp', rootDir: '/mnt/cold' });

  // the end record is in the first chunk; the next read fails
  const input = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode('{"guid":"0199a","baseGuid":null}'));
    },
    pull: (controller) => {
      controller.error(new Error('ssh: connection reset'));
    },
  });

  const received = target.streams.writeTo(['zfs', 'recv', '-u', 'cold/imp/a@one'], input);

  expect(received).rejects.toThrowWithMessage(Error, 'ssh: connection reset');
  expect(target.listSnapshots()).toStrictEqual(['cold/imp/a@one']);
});
