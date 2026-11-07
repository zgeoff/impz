import { EventCursorSchema } from '@impz/api';
import type { ImpEvent } from '@impz/api';
import { P, match } from 'ts-pattern';
import * as z from 'zod';
import type { ImpGuard } from '../imp-guard';
import { defineTool } from './define-tool';
import type { Tool } from './define-tool';

export const EVENT_TOOL: Tool = defineTool({
  name: 'imp_event_list',
  scope: 'read',
  description:
    "Read what happened to the imps, oldest first, one page per call. With no after, it returns each imp as it is now and a cursor; pass the after and logId it returns to read only what happened since. A Reset event means the events since the cursor are gone, and each imp as it is now follows. An ImpChanged event's reason says what changed, such as slept, woke or failed.",
  input: z.strictObject({
    after: EventCursorSchema.shape.after.describe('The after of the last call; omit it at first'),
    logId: EventCursorSchema.shape.logId.describe('The logId of the last call'),
    limit: z
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('The most events to return, 100 when omitted'),
  }),
  annotations: { title: 'List imp events', readOnlyHint: true, openWorldHint: false },
  run: async (input, context) => {
    const page = await context.client.events.list(input);

    return {
      data: {
        ...page,
        events: page.events.filter((event) => isAllowedEvent(context.guard, event)),
      },
    };
  },
});

function isAllowedEvent(guard: ImpGuard, event: ImpEvent): boolean {
  return match(event)
    .with({ ev: P.union('Reset', 'Position') }, () => true)
    .with({ ev: P.union('ImpAdded', 'ImpChanged', 'ImpRemoved') }, (changed) =>
      guard.isAllowed(changed.imp.name),
    )
    .with(
      { ev: P.union('CheckpointAdded', 'CheckpointRemoved', 'GovernorDecision', 'AgentExec') },
      (named) => guard.isAllowed(named.name),
    )
    .otherwise(() => false);
}
