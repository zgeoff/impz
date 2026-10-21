import type { MoveState } from '@impz/api';

export const MOVE_TRANSITIONS: readonly (readonly [MoveState | null, MoveState | null])[] = [
  [null, 'sending'],
  ['sending', null],
  ['sending', 'moved'],
  ['moved', null],
  [null, 'receiving'],
  ['receiving', null],
];
