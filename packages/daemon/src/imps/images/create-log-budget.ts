export const BUILD_LOG_QUEUE_MAX_BYTES = 1024 ** 2;

export interface LogBudget {
  readonly admit: (line: string, hasRoom: boolean) => string[];

  readonly drain: () => string[];
}

export function createLogBudget(): LogBudget {
  const state = { dropped: 0 };

  const drain = (): string[] => {
    if (state.dropped === 0) {
      return [];
    }

    const count = state.dropped === 1 ? '1 line' : `${String(state.dropped)} lines`;
    const marker = `imp: ${count} of build output dropped: the client read them more slowly than the build wrote them`;

    state.dropped = 0;

    return [marker];
  };

  return {
    admit: (line, hasRoom) => {
      if (!hasRoom) {
        state.dropped += 1;

        return [];
      }

      return [...drain(), line];
    },
    drain,
  };
}
