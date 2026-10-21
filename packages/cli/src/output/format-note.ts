import type { Imp } from '@impz/api';

export function formatNote(imp: Imp): string {
  const notes: string[] = [];

  // first: during a move the imp shows on both hosts, and this says which
  // side each row is
  if (imp.move !== undefined) {
    notes.push(imp.move);
  }

  if (imp.kind === 'builder') {
    notes.push('image builder');
  }

  if (imp.agentSilentSince !== undefined) {
    notes.push(`agent silent since ${imp.agentSilentSince.toISOString()}`);
  }

  if (imp.inner?.up === false) {
    notes.push('container down');
  }

  if (imp.public !== undefined) {
    const auth = imp.public.auth === 'none' ? '' : ` (${imp.public.auth})`;

    notes.push(`public${auth}`);
  }

  if (imp.coldBootReason !== undefined) {
    const when = imp.state === 'sleeping' ? 'boots cold' : 'booted cold';

    notes.push(`${when}: ${imp.coldBootReason}`);
  }

  const outdated = imp.outdated ?? [];
  const parts = outdated.filter((part) => part !== 'impd' && part !== 'ipv6');

  if (outdated.includes('impd')) {
    notes.push('booted by an older impd; its next wake boots cold');
  }

  if (parts.length > 0) {
    notes.push(`outdated: ${parts.join(', ')}`);
  }

  if (outdated.includes('ipv6')) {
    notes.push('no IPv6 until its next cold boot');
  }

  return notes.join('; ');
}
