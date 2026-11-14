import { WringerError } from '@wringer/core';
import type { StreamClient } from '@wringer/stream';
import { collectImpEvents } from './collect-imp-events.ts';
import type { ImpEventStep } from './collect-imp-events.ts';
import { findLifecycleGap } from './find-lifecycle-gap.ts';

// The removal can reach the stream after the destroy answers, so a read waits this long for it.
const SETTLE_MS = 5000;

// Reads what `impz events` printed since `use` last marked the stream, until the imp with the name
// was added, ran, slept and was removed, in order. Fails with `check-failed` when it was not within
// the settle time.
export async function readImpEvents(
  client: StreamClient,
  name: string,
): Promise<{ readonly events: ImpEventStep[] }> {
  const deadline = Date.now() + SETTLE_MS;

  for (;;) {
    const lines = await readStreamLines(client);

    const events = collectImpEvents(lines, name);
    const gap = findLifecycleGap(events);

    if (gap === null) {
      return { events };
    }

    if (Date.now() >= deadline) {
      throw new WringerError('check-failed', {
        message: `the events of ${name} lack ${gap}; they are ${JSON.stringify(events)}`,
      });
    }

    await Bun.sleep(200);
  }
}

async function readStreamLines(client: StreamClient): Promise<string[]> {
  const lines: string[] = [];
  let from: number | undefined;

  for (;;) {
    const slice = await client.read({ name: 'events', ...(from === undefined ? {} : { from }) });

    lines.push(...slice.records.map((record) => record.line));

    if (!slice.more) {
      return lines;
    }

    from = slice.cursor;
  }
}
