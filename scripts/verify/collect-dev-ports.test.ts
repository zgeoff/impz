import { expect, test } from 'bun:test';
import { collectDevPorts } from './collect-dev-ports.ts';

test('it lists the API, MCP, proxy and ssh ports, then the 64 imp ports, at the offset', () => {
  const imps = Array.from({ length: 64 }, (_, index) => 20_500 + index);

  expect(collectDevPorts(500)).toStrictEqual([7570, 7571, 7580, 2722, ...imps]);
});

test('it shares no port between two offsets 100 apart', () => {
  const first = new Set(collectDevPorts(500));

  expect(collectDevPorts(600).filter((port) => first.has(port))).toStrictEqual([]);
});
