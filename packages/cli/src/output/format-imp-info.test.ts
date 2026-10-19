import { expect, test } from 'bun:test';
import { buildMockImp } from '@impz/api/test-utils/build-mock-imp';
import { formatImpInfo } from './format-imp-info';

test('#formatImpInfo shows an awake imp’s container with its restarts and last error', () => {
  const imp = buildMockImp({
    name: 'web',
    state: 'running',
    image: 'base',
    ip: '10.66.0.6',
    url: 'http://web.imp.test',
    inner: { up: false, restarts: 3, lastError: 'start inner init: exit status 1' },
  });

  const { move, agentSilentSince, public: exposure, coldBootReason, outdated, ...quiet } = imp;

  expect(formatImpInfo({ ...quiet, kind: 'user' }).split('\n')).toStrictEqual([
    'name        web',
    'state       running',
    'image       base',
    'ip          10.66.0.6',
    'url         http://web.imp.test',
    'container   down',
    'restarts    3',
    'last error  start inner init: exit status 1',
    'note        container down',
  ]);
});

test('#formatImpInfo shows the container unknown for an awake imp whose agent has not answered', () => {
  const { inner, ...imp } = buildMockImp({ state: 'running' });

  expect(formatImpInfo(imp).split('\n')).toContain('container   unknown');
});

test('#formatImpInfo shows the container not running for a sleeping imp', () => {
  const { inner, ...imp } = buildMockImp({ state: 'sleeping' });

  expect(formatImpInfo(imp).split('\n')).toContain('container   not running');
});
