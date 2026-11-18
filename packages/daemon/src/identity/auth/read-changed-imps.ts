import type { Access } from './access-policy';
import { findField } from './access-policy';

const HOST_IMP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'imps.expose': ['name'],
  'imps.unexpose': ['name'],
  'networks.join': ['name'],
  'networks.leave': ['name'],
  'images.add': ['imp'],
  'moves.reissue': ['name'],
};

export function readChangedImps(
  procedure: string,
  access: Readonly<Access> | null,
  input: unknown,
): string[] {
  if (access === null || access.scope === 'read' || procedure === 'imps.destroy') {
    return [];
  }

  const fields =
    access.on === 'imp' || access.on === 'grant' ? access.fields : HOST_IMP_FIELDS[procedure];

  return (fields ?? []).flatMap((field) => findField(input, field) ?? []);
}
