import type { Imp } from '@impz/api';
import { formatNote } from './format-note';

export function formatImpInfo(imp: Imp): string {
  const inner = imp.inner;
  const note = formatNote(imp);

  const lines = [
    ['name', imp.name],
    ['state', imp.state],
    ['image', imp.image],
    ['ip', imp.ip],
    ['url', imp.url],
    ['container', formatContainer(imp)],
    ...(inner === undefined ? [] : [['restarts', String(inner.restarts)]]),
    ...(inner?.lastError === undefined ? [] : [['last error', inner.lastError]]),
    ...(note === '' ? [] : [['note', note]]),
  ];

  return lines.map(([label = '', value = '']) => `${label.padEnd(12)}${value}`).join('\n');
}

function formatContainer(imp: Imp): string {
  if (imp.state !== 'running') {
    return 'not running';
  }

  if (imp.inner === undefined) {
    return 'unknown';
  }

  return imp.inner.up ? 'up' : 'down';
}
