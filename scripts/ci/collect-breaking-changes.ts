import type { ProtocolSchema } from '../../packages/api/src/protocols/build-protocol-schema';
import type { JsonOutputSchema } from '../../packages/cli/src/output/build-json-output-schema';
import { collectSchemaChanges } from './collect-schema-changes';
import { formatValue } from './format-value';

// The changes from base to head that break a client of the other version, by
// the rules in docs/runbooks/releasing.md#breaking-changes.
export function collectBreakingChanges(base: ProtocolSchema, head: ProtocolSchema): string[] {
  return [
    ...collectProcedureChanges(base, head),
    ...collectMessageChanges(base, head),
    ...collectErrorChanges(base, head),
    ...collectConstantChanges(base, head),
  ];
}

// The changes from base to head that break a program reading `impz <command>
// --json`, which reads what impd sends: docs/guides/cli.md#json-output.
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
