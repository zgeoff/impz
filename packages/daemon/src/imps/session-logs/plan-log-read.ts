export interface LogSegment {
  readonly start: number;
  readonly length: number;
}

export interface LogBounds {
  readonly logStart: number;
  readonly logEnd: number;
}

export type LogReadPlan =
  | ({ readonly kind: 'past_end' } & LogBounds)
  | ({
      readonly kind: 'read';

      readonly offset: number;

      readonly gap: { readonly from: number; readonly to: number } | null;

      readonly segment: LogSegment | null;
      readonly skip: number;
      readonly length: number;
    } & LogBounds);

export function getLogBounds(segments: readonly LogSegment[], origin: number): LogBounds {
  const [first] = segments;
  const last = segments.at(-1);

  return {
    logStart: first?.start ?? origin,
    logEnd: last === undefined ? origin : last.start + last.length,
  };
}

export function planLogRead(
  segments: readonly LogSegment[],
  origin: number,
  from: number,
  limit: number,
): LogReadPlan {
  const bounds = getLogBounds(segments, origin);

  if (from > bounds.logEnd) {
    return { kind: 'past_end', ...bounds };
  }

  const segment = segments.find((each) => each.start + each.length > from);

  if (segment === undefined) {
    const gap = from < bounds.logStart ? { from, to: bounds.logStart } : null;

    return {
      kind: 'read',
      offset: gap?.to ?? from,
      gap,
      segment: null,
      skip: 0,
      length: 0,
      ...bounds,
    };
  }

  const offset = Math.max(from, segment.start);

  return {
    kind: 'read',
    offset,
    gap: offset > from ? { from, to: offset } : null,
    segment,
    skip: offset - segment.start,
    length: Math.min(limit, segment.start + segment.length - offset),
    ...bounds,
  };
}
