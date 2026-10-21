import type { ServiceLogChunk, ServiceLogStream } from '../../vm/agent-client/service-requests';
import type { LogDecoders } from './create-log-decoders';

export interface NamedStream {
  readonly service: string;
  readonly stream: ServiceLogStream;
}

export interface MergedChunk {
  readonly service: string;
  readonly chunk: ServiceLogChunk;

  readonly text: string;
}

interface Pending {
  readonly result: IteratorResult<ServiceLogChunk, void>;
  readonly index: number;
}

export async function* mergeLogStreams(
  streams: readonly NamedStream[],
  decoders: LogDecoders,
): AsyncGenerator<MergedChunk, void, undefined> {
  const iterators = streams.map((entry) => entry.stream.chunks());

  const readNext = async (index: number): Promise<Pending> => {
    const iterator = iterators[index];

    if (iterator === undefined) {
      throw new Error(`no log stream ${String(index)}`);
    }

    const result = await iterator.next();

    return { result, index };
  };

  const pending = new Map<number, Promise<Pending>>(
    streams.map((_entry, index) => [index, readNext(index)]),
  );

  while (pending.size > 0) {
    const next = await Promise.race(pending.values());

    const service = streams[next.index]?.service ?? '';

    if (next.result.done === true) {
      pending.delete(next.index);
      continue;
    }

    pending.set(next.index, readNext(next.index));

    const chunk = next.result.value;
    const text = chunk.kind === 'data' ? decoders.readText(service, chunk.data) : '';

    yield { service, chunk, text };
  }
}
