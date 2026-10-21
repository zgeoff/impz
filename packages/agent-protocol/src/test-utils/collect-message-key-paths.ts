import type { DescMessage } from '@bufbuild/protobuf';

export function collectMessageKeyPaths(schema: DescMessage, prefix = ''): string[] {
  const paths = schema.fields.flatMap((field) => {
    const path = prefix === '' ? field.name : `${prefix}.${field.name}`;

    if (field.fieldKind === 'message') {
      return [path, ...collectMessageKeyPaths(field.message, path)];
    }

    if (field.fieldKind === 'list') {
      const items = `${path}[]`;

      return field.listKind === 'message'
        ? [path, items, ...collectMessageKeyPaths(field.message, items)]
        : [path, items];
    }

    return [path];
  });

  return paths.toSorted();
}
