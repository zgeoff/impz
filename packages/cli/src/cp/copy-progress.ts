import { formatBytes } from '@impz/shared';

export interface CopyProgress {
  readonly setTotal: (bytes: number) => void;
  readonly add: (bytes: number) => void;
  readonly finish: () => void;
}

export interface ProgressOutput {
  readonly isTTY: boolean;
  readonly write: (text: string) => void;
}

// a fast copy must not spend its time printing
const REDRAW_MS = 250;

export function formatProgress(copied: number, total: number | null, label = 'impz cp'): string {
  if (total === null || total === 0) {
    return `${label}: ${formatBytes(copied)}`;
  }

  const percent = Math.min(100, Math.floor((copied / total) * 100));

  return `${label}: ${String(percent)}% ${formatBytes(copied)} of ${formatBytes(total)}`;
}

export function createCopyProgress(
  output: ProgressOutput,
  now = Date.now,
  label = 'impz cp',
): CopyProgress {
  const state = { copied: 0, total: null as number | null, drawnAt: 0, drawn: false };

  const renderLine = (): void => {
    state.drawnAt = now();
    state.drawn = true;

    output.write(`\r${formatProgress(state.copied, state.total, label)}\u001B[K`);
  };

  return {
    setTotal: (bytes) => {
      state.total = bytes;
    },
    add: (bytes) => {
      state.copied += bytes;

      if (output.isTTY && now() - state.drawnAt >= REDRAW_MS) {
        renderLine();
      }
    },

    finish: () => {
      if (output.isTTY && state.drawn) {
        renderLine();

        output.write('\n');

        state.drawn = false;
      }
    },
  };
}
