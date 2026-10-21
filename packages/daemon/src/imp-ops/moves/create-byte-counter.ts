import { MoveRequestError } from './move-request-error';

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
