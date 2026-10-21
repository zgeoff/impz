import { ScalarType } from '@bufbuild/protobuf';
import type { DescField, DescFile, DescMessage } from '@bufbuild/protobuf';

// The syntax statement is field 12 of a protobuf file descriptor, and its source location holds
// the comment at the head of the file.
const SYNTAX_PATH = 12;

export function renderProtocolReference(file: DescFile, title: string): string {
  const lines = [
    `# ${title}`,
    '',
    `<!-- Generated from ${file.proto.name} by bun run gen:proto. Edit the schema, not this file. -->`,
    '',
    ...renderComment(getComment(file, [SYNTAX_PATH])),
    'In each table, a field marked always is in every message the agent writes, zero or not; impd leaves a zero out, which reads as zero. A field marked when set appears only when its sender sets it, and a list appears as [] or not at all.',
    '',
  ];

  for (const message of file.messages) {
    lines.push(...renderMessage(file, message));
  }

  return `${lines.join('\n')}\n`;
}

function renderComment(comment: string): string[] {
  if (comment === '') {
    return [];
  }

  const lines = comment.split('\n').map((line) => line.replace(/^ /u, ''));

  return [...lines, ''];
}

function getComment(file: DescFile, path: readonly number[]): string {
  const location = file.proto.sourceCodeInfo?.location.find(
    (candidate) =>
      candidate.path.length === path.length &&
      candidate.path.every((part, index) => part === path[index]),
  );

  return location?.leadingComments.trim() ?? '';
}

const MESSAGE_PATH = 4;
const FIELD_PATH = 2;

function renderMessage(file: DescFile, message: DescMessage): string[] {
  const path = [MESSAGE_PATH, file.messages.indexOf(message)];

  const rows = message.fields.map((field) => {
    const comment = getComment(file, [...path, FIELD_PATH, message.fields.indexOf(field)]);

    return `| \`${field.name}\` | ${formatType(field)} | ${formatPresence(field)} | ${formatCell(comment)} |`;
  });

  return [
    `## ${message.name}`,
    '',
    ...renderComment(getComment(file, path)),
    ...(rows.length === 0
      ? ['No fields.', '']
      : ['| Field | Type | Presence | Description |', '| --- | --- | --- | --- |', ...rows, '']),
  ];
}

function formatType(field: DescField): string {
  if (field.fieldKind === 'scalar') {
    return formatScalar(field.scalar);
  }

  if (field.fieldKind === 'message') {
    return formatMessageLink(field.message);
  }

  if (field.fieldKind === 'list') {
    return `list of ${field.listKind === 'scalar' ? formatScalar(field.scalar) : formatListMember(field)}`;
  }

  throw new Error(`render-protocol-reference: ${field.name} is a ${field.fieldKind} field`);
}

function formatScalar(scalar: ScalarType): string {
  return scalar === ScalarType.BYTES ? 'bytes (base64)' : ScalarType[scalar].toLowerCase();
}

function formatMessageLink(message: DescMessage): string {
  return `[${message.name}](#${message.name.toLowerCase()})`;
}

function formatListMember(field: DescField): string {
  if (field.fieldKind !== 'list' || field.listKind !== 'message') {
    throw new Error(`render-protocol-reference: ${field.name} is not a list of messages`);
  }

  return formatMessageLink(field.message);
}

function formatPresence(field: DescField): string {
  if (field.fieldKind === 'list') {
    return 'list';
  }

  if (field.fieldKind === 'message' || field.proto.proto3Optional) {
    return 'when set';
  }

  return 'always';
}

function formatCell(comment: string): string {
  return comment
    .replaceAll('\n', ' ')
    .replaceAll(/\s+/gu, ' ')
    .replaceAll('|', String.raw`\|`);
}
