import * as z from 'zod';
import type { StreamRunner } from '../process/run-stream';
import type { FakeDataset, FakeSnapshot } from './build-stub-zfs';

// what buildStubZfs lends its streams: its pool, its txg counter and its
// command log
interface StubZfsStreamContext {
  readonly datasets: Map<string, FakeDataset>;
  readonly snapshots: Map<string, FakeSnapshot>;
  readonly state: { txg: number };
  readonly commands: string[];
  readonly findSnapshotsOf: (dataset: string) => string[];
}

// what the fake's `zfs send` writes: the snapshot and the one it is
// incremental from
const FakeStreamSchema = z.object({ guid: z.string(), baseGuid: z.string().nullable() });

// The fake pool's `zfs send` and `zfs recv`, which pass a snapshot's guid
// and its base's from one fake pool to another
export function buildStubZfsStreams(ctx: StubZfsStreamContext): StreamRunner {
  // zfs send [-i <base>] <snapshot>: the stream names both by guid
  const openSend = (argv: readonly string[]) => {
    const snapshot = ctx.snapshots.get(argv.at(-1) ?? '');
    const baseIndex = argv.indexOf('-i');
    const base = baseIndex === -1 ? null : ctx.snapshots.get(argv[baseIndex + 1] ?? '');

    if (snapshot === undefined || base === undefined) {
      throw new Error(`fake zfs: ${argv.join(' ')}: no such snapshot`);
    }

    const stream = { guid: snapshot.guid, baseGuid: base?.guid ?? null };

    return Response.json(stream).body ?? new ReadableStream();
  };

  // zfs recv -u [-o origin=<snapshot>] <dataset>@<snapshot>, as real ZFS
  // takes a full, an incremental or a clone stream
  const runReceive = (argv: readonly string[], stream: z.infer<typeof FakeStreamSchema>) => {
    const target = argv.at(-1) ?? '';
    const [dataset = '', snapshotName = ''] = target.split('@');
    const originArg = argv.find((arg) => arg.startsWith('origin='));
    const origin = originArg?.slice('origin='.length) ?? null;
    const exists = ctx.datasets.has(dataset);

    if (stream.baseGuid === null) {
      if (exists) {
        throw new Error(`cannot receive new filesystem stream: destination '${dataset}' exists`);
      }

      ctx.datasets.set(dataset, { origin: null, txg: ctx.state.txg++ });
    } else if (exists) {
      const latest = ctx
        .findSnapshotsOf(dataset)
        .toSorted(
          (left, right) =>
            (ctx.snapshots.get(left)?.txg ?? 0) - (ctx.snapshots.get(right)?.txg ?? 0),
        )
        .at(-1);

      if (latest === undefined || ctx.snapshots.get(latest)?.guid !== stream.baseGuid) {
        throw new Error(
          `cannot receive incremental stream: most recent snapshot of ${dataset} does not match incremental source`,
        );
      }
    } else {
      if (origin === null || ctx.snapshots.get(origin)?.guid !== stream.baseGuid) {
        throw new Error(`cannot receive: local origin for clone ${dataset} does not exist`);
      }

      ctx.datasets.set(dataset, { origin, txg: ctx.state.txg++ });
    }

    ctx.snapshots.set(`${dataset}@${snapshotName}`, {
      txg: ctx.state.txg++,
      deferDestroy: false,
      guid: stream.guid,
    });
  };

  return {
    readFrom: (argv) => {
      ctx.commands.push(argv.join(' '));

      return { stdout: openSend(argv), done: Promise.resolve(), stop: () => Promise.resolve() };
    },

    // As real ZFS, the receive commits once the stream's end record (here
    // the JSON's last byte) is in, whether or not the input fails after it
    writeTo: async (argv, input) => {
      ctx.commands.push(argv.join(' '));

      const decoder = new TextDecoder();

      const read = { text: '', isCommitted: false };

      for await (const chunk of input) {
        read.text += decoder.decode(chunk, { stream: true });

        const stream = read.isCommitted ? undefined : readFakeStream(read.text);

        if (stream !== undefined) {
          runReceive(argv, stream);

          read.isCommitted = true;
        }
      }

      if (!read.isCommitted) {
        throw new Error('cannot receive: the stream ended early');
      }
    },
  };
}

// a whole fake stream, or undefined while its end has not come
function readFakeStream(text: string): z.infer<typeof FakeStreamSchema> | undefined {
  try {
    return FakeStreamSchema.parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}
