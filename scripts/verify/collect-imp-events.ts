import * as z from 'zod';

const lineSchema = z.object({
  ev: z.string(),
  reason: z.string().optional(),
  imp: z.object({ name: z.string(), state: z.string() }).optional(),
});

export interface ImpEventStep {
  readonly ev: string;
  readonly reason: string | null;
  readonly state: string;
}

// The events of the imp with the name, in the order `impz events` printed them, from its lines. A
// line that is not an event of an imp, such as a reconnect warning, is skipped.
export function collectImpEvents(lines: readonly string[], name: string): ImpEventStep[] {
  return lines.flatMap((line) => {
    const parsed = lineSchema.safeParse(parseJSONOrNull(line));

    if (!parsed.success || parsed.data.imp?.name !== name) {
      return [];
    }

    return [
      { ev: parsed.data.ev, reason: parsed.data.reason ?? null, state: parsed.data.imp.state },
    ];
  });
}

function parseJSONOrNull(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
