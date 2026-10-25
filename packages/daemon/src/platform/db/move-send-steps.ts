export type MoveSendStep = 'prepared' | 'streaming' | 'sent';

export const MOVE_SEND_STEPS: readonly (readonly [MoveSendStep, MoveSendStep])[] = [
  ['prepared', 'streaming'],
  ['streaming', 'sent'],
];
