import { expect, onTestFinished, test } from 'bun:test';
import { getConfig } from '@logtape/logtape';
import { getImpdLogger } from '../../src/platform/process/get-impd-logger';
import { startImpdLogCapture } from './start-impd-log-capture';

test('it hands each impd line to every capture that runs', () => {
  const first: string[] = [];
  const second: string[] = [];

  onTestFinished(
    startImpdLogCapture((line) => {
      first.push(line);
    }),
  );

  onTestFinished(
    startImpdLogCapture((line) => {
      second.push(line);
    }),
  );

  getImpdLogger('disk').warning('low on disk');

  expect(first).toStrictEqual(['WARNING impd.disk low on disk']);
  expect(second).toStrictEqual(['WARNING impd.disk low on disk']);
});

test('it hands no line to a capture that stopped while another runs', () => {
  const stopped: string[] = [];
  const running: string[] = [];

  const stop = startImpdLogCapture((line) => {
    stopped.push(line);
  });

  onTestFinished(
    startImpdLogCapture((line) => {
      running.push(line);
    }),
  );

  stop();
  getImpdLogger('gc').info('removed volume v1');

  expect(stopped).toStrictEqual([]);
  expect(running).toStrictEqual(['INFO impd.gc removed volume v1']);
});

test('it leaves logging unconfigured once the last capture stops', () => {
  const stopFirst = startImpdLogCapture(() => {});
  const stopSecond = startImpdLogCapture(() => {});

  stopFirst();

  const isConfiguredBetween = getConfig() !== null;

  stopSecond();

  expect(isConfiguredBetween).toBeTrue();
  expect(getConfig()).toBeNull();
});
