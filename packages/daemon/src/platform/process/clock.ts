export type StartTimer = (fire: () => void, durationMs: number) => () => void;

export interface Clock {
  readonly now: () => number;
  readonly startTimer: StartTimer;
  readonly sleep: (durationMs: number) => Promise<void>;
}
