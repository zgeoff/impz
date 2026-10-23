import { expect, test } from 'bun:test';
import { pickProxyAction } from './pick-proxy-action.ts';

test.each([
  {
    action: 'reuse',
    label: 'a running proxy with the same stamp under keep',
    proxy: { isRunning: true, stamp: 'b1', storedStamp: 'b1', mode: 'keep' },
  },
  {
    action: 'reuse',
    label: 'a running proxy with the same stamp under replace',
    proxy: { isRunning: true, stamp: 'b1', storedStamp: 'b1', mode: 'replace' },
  },
  {
    action: 'defer',
    label: 'a running proxy with a changed stamp under keep',
    proxy: { isRunning: true, stamp: 'b2', storedStamp: 'b1', mode: 'keep' },
  },
  {
    action: 'replace',
    label: 'a running proxy with a changed stamp under replace',
    proxy: { isRunning: true, stamp: 'b2', storedStamp: 'b1', mode: 'replace' },
  },
  {
    action: 'replace',
    label: 'a running proxy with no stored stamp under replace',
    proxy: { isRunning: true, stamp: 'b2', storedStamp: '', mode: 'replace' },
  },
  {
    action: 'replace',
    label: 'a stopped proxy under keep',
    proxy: { isRunning: false, stamp: 'b1', storedStamp: 'b1', mode: 'keep' },
  },
  {
    action: 'replace',
    label: 'a stopped proxy under replace',
    proxy: { isRunning: false, stamp: 'b1', storedStamp: 'b1', mode: 'replace' },
  },
] as const)('it picks $action for $label', (row) => {
  expect(pickProxyAction(row.proxy)).toBe(row.action);
});
