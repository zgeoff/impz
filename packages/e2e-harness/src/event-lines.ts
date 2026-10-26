import { readLines } from '@impz/shared';
import * as z from 'zod';

const EventLineSchema = z.object({
  ev: z.string(),
  reason: z.string().optional(),
  name: z.string().optional(),
  imp: z.object({ name: z.string(), state: z.string() }).optional(),
});

export function formatEventLine(line: string): string | null {
  const event = EventLineSchema.parse(JSON.parse(line));

  if (event.ev === 'GovernorDecision') {
    return null;
  }

  const words = [
    event.imp?.name ?? event.name,
    event.ev,
    event.reason,
    event.reason === 'snapshot' ? event.imp?.state : undefined,
  ];

  return words.filter((word) => word !== undefined).join(' ');
}

export async function readEventLines(
  stdout: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  for await (const line of readLines(stdout)) {
    const formatted = formatEventLine(line);

    if (formatted !== null) {
      onLine(formatted);
    }
  }
}
