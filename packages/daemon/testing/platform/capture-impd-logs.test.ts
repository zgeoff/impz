import { expect, test } from 'bun:test';
import { getConfig } from '@logtape/logtape';
import { getImpdLogger } from '../../src/platform/process/get-impd-logger';
import { captureImpdLogs } from './capture-impd-logs';

test('it captures each impd line as rendered, without its newline', () => {
  const lines = captureImpdLogs();

  getImpdLogger('image').info('image build {name}: pins={pinsMs}ms', { name: 'web', pinsMs: 12 });
  getImpdLogger('image').with({ imp: 'web' }).warning('template {name} failed', { name: 't' });

  expect(lines).toStrictEqual([
    'INFO impd.image image build web: pins=12ms',
    'WARNING impd.image imp=web template t failed',
  ]);
});

test('it leaves logging unconfigured after the test that captured', () => {
  expect(getConfig()).toBeNull();
});
