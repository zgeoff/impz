interface BackoffSpec {
  readonly baseMs: number;

  readonly capMs: number;
}

export function buildBackoffMs(failures: number, spec: Readonly<BackoffSpec>): number {
  if (failures <= 0) {
    return 0;
  }

  return Math.min(spec.capMs, spec.baseMs * 2 ** (failures - 1));
}
