export type StartTimer = (fire: () => void, durationMs: number) => () => void;
