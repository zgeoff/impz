import { MoveRequestError } from './move-request-error';

// the data bytes a stream carried; past its ticket's count, it stops
export interface ByteCounter {
  readonly add: (bytes: number) => void;
}

export function createByteCounter(limit: number): ByteCounter {
  let bytes = 0;

  return {
    add: (more) => {
      bytes += more;

      if (bytes > limit) {
        throw new MoveRequestError(413, 'the stream is longer than its ticket allows');
      }
    },
  };
}
