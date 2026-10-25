// oRPC buffers a File or Blob input in memory, and a stream part runs to hundreds of MiB, so the
// move stream goes to a plain POST route beside the move peer contract.
export const MOVE_RECEIVE_PATH = '/move/receive';
