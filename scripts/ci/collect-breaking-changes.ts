import type { ProtocolSchema } from '@impz/api';
import type { JsonOutputSchema } from '@impz/cli/output-schema';
import { collectSchemaChanges } from './breaking-changes/collect-schema-changes';
import { formatValue } from './breaking-changes/format-value';

export function collectBreakingChanges(base: ProtocolSchema, head: ProtocolSchema): string[] {
  return [
    ...collectProcedureChanges(base, head),
    ...collectMessageChanges(base, head),
    ...collectErrorChanges(base, head),
    ...collectConstantChanges(base, head),
  ];
}

export function collectJsonOutputChanges(base: JsonOutputSchema, head: JsonOutputSchema): string[] {
  return Object.entries(base.outputs).flatMap(([command, before]) => {
    const after = head.outputs[command];
    const label = `impz ${command} --json`;

    if (after === undefined) {
      return [`${label}: removed`];
    }

    return collectSchemaChanges(label, 'toClient', before.schema, after.schema, true);
  });
}

function collectProcedureChanges(base: ProtocolSchema, head: ProtocolSchema): string[] {
  const changes: string[] = [];

  for (const [name, before] of Object.entries(base.procedures)) {
    const after = head.procedures[name];
    const label = `procedure ${name}`;

    if (after === undefined) {
      changes.push(`${label}: removed`);
    } else if (before.stream === after.stream) {
      changes.push(
        ...collectSchemaChanges(`${label} input`, 'toServer', before.input, after.input),
        ...collectSchemaChanges(`${label} output`, 'toClient', before.output, after.output),
      );
    } else {
      changes.push(`${label}: ${formatStream(before.stream)} → ${formatStream(after.stream)}`);
    }
  }

  return changes;
}

function formatStream(stream: boolean): string {
  return stream ? 'event stream' : 'single answer';
}

function collectMessageChanges(base: ProtocolSchema, head: ProtocolSchema): string[] {
  return Object.entries(base.messages).flatMap(([name, before]) => {
    const after = head.messages[name];
    const label = `message ${name}`;

    if (after === undefined) {
      return [`${label}: removed`];
    }

    if (before.direction !== after.direction) {
      return [`${label}: ${before.direction} → ${after.direction}`];
    }

    return collectSchemaChanges(label, before.direction, before.schema, after.schema);
  });
}

function collectErrorChanges(base: ProtocolSchema, head: ProtocolSchema): string[] {
  const changes: string[] = [];

  for (const [code, before] of Object.entries(base.errors)) {
    const after = head.errors[code];
    const label = `error ${code}`;

    if (after === undefined) {
      changes.push(`${label}: removed`);
      continue;
    }

    if (before.status !== after.status) {
      changes.push(`${label}: status ${formatValue(before.status)} → ${formatValue(after.status)}`);
    }

    changes.push(...collectSchemaChanges(`${label} data`, 'toClient', before.data, after.data));
  }

  return changes;
}

function collectConstantChanges(base: ProtocolSchema, head: ProtocolSchema): string[] {
  return Object.entries(base.constants).flatMap(([name, before]) => {
    if (!(name in head.constants)) {
      return [`constant ${name}: removed`];
    }

    const after = head.constants[name];

    return Bun.deepEquals(before, after, true)
      ? []
      : [`constant ${name}: ${formatValue(before)} → ${formatValue(after)}`];
  });
}
