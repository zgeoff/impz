import type { Imp } from '@impz/api';
import { formatNote } from './format-note';

// `impz info <name>`: one imp, a field a line, with its inner container's
// state, restarts and last error
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

// the inner container, where the imp's processes run: known only while the
// imp is awake and its agent answers
function formatContainer(imp: Imp): string {
  if (imp.state !== 'running') {
    return 'not running';
  }

  if (imp.inner === undefined) {
    return 'unknown';
  }

  return imp.inner.up ? 'up' : 'down';
}
