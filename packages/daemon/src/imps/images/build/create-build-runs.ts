import type { ImageBuildPhase, ImageBuildRun, ImageBuildSource } from '@impz/api';

export interface BuildRun {
  readonly setPhase: (phase: ImageBuildPhase) => void;
  readonly setStep: (step: string) => void;
  readonly setBuilder: (name: string) => void;
  readonly end: () => void;
}

export interface BuildRuns {
  readonly start: (name: string, source: ImageBuildSource) => BuildRun;

  readonly list: () => ImageBuildRun[];
}

export function createBuildRuns(now: () => number): BuildRuns {
  const runs = new Set<{ run: ImageBuildRun }>();

  return {
    start: (name, source) => {
      const entry: { run: ImageBuildRun } = {
        run: {
          name,
          source,
          startedAt: new Date(now()),
          phase: source === 'upload' ? 'upload' : 'pack',
          step: null,
          builder: null,
        },
      };

      runs.add(entry);

      return {
        setPhase: (phase) => {
          entry.run = { ...entry.run, phase };
        },
        setStep: (step) => {
          entry.run = { ...entry.run, step };
        },
        setBuilder: (builder) => {
          entry.run = { ...entry.run, builder };
        },
        end: () => {
          runs.delete(entry);
        },
      };
    },
    list: () => [...runs].map((entry) => entry.run),
  };
}
