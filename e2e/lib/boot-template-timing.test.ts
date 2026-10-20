import { expect, test } from 'bun:test';
import {
  getU32Span,
  parseLoggedGuestSteps,
  parseLoggedSteps,
  pickPercentile,
} from './boot-template-timing';

test('#getU32Span measures the distance between two values', () => {
  expect(getU32Span(1000, 250)).toBe(750);
});

test('#getU32Span measures around the wrap', () => {
  expect(getU32Span(2 ** 32 - 10, 5)).toBe(15);
});

test('#parseLoggedSteps reads the steps of the last line that names the imp', () => {
  const log = [
    'impd: e2e-bt-t0: restored boot template 0123456789ab as pid 7 load=1ms agent=2ms',
    'impd: e2e-bt-t1: restored boot template 0123456789ab as pid 9 load=12ms agent=30ms',
    'impd: e2e-bt-t1: restored boot template 0123456789ab as pid 11 load=14ms agent=31ms',
  ].join('\n');

  expect(parseLoggedSteps(log, 'e2e-bt-t1', 'restored boot template')).toStrictEqual({
    load: 14,
    agent: 31,
  });
});

test('#parseLoggedSteps adds the total of a created line', () => {
  const log = 'impd: e2e-bt-t0: created in 48ms (disk=5ms boot=40ms)\n';

  expect(parseLoggedSteps(log, 'e2e-bt-t0', 'created in')).toStrictEqual({
    disk: 5,
    boot: 40,
    total: 48,
  });
});

test('#parseLoggedSteps leaves out the guest steps of a line', () => {
  const log =
    'impd: e2e-bt-t0: restored boot template 0123456789ab as pid 7 claim=4ms agent=90ms; guest claim=3ms mount=40ms\n';

  expect(parseLoggedSteps(log, 'e2e-bt-t0', 'restored boot template')).toStrictEqual({
    claim: 4,
    agent: 90,
  });
});

test('#parseLoggedGuestSteps reads the guest steps of the last line that names the imp', () => {
  const log = [
    'impd: e2e-bt-t1: restored boot template 0123456789ab as pid 9 agent=80ms; guest claim=2ms ready=1ms',
    'impd: e2e-bt-t1: restored boot template 0123456789ab as pid 11 claim=4ms agent=90ms; guest claim=3ms mount=40ms ready=2ms',
  ].join('\n');

  expect(parseLoggedGuestSteps(log, 'e2e-bt-t1', 'restored boot template')).toStrictEqual({
    claim: 3,
    mount: 40,
    ready: 2,
  });
});

test('#parseLoggedGuestSteps reads a line from an agent without guest steps as none', () => {
  const log = 'impd: e2e-bt-t0: restored boot template 0123456789ab as pid 7 agent=90ms\n';

  expect(parseLoggedGuestSteps(log, 'e2e-bt-t0', 'restored boot template')).toStrictEqual({});
});

test('#parseLoggedGuestSteps reads a log without the imp as no steps', () => {
  expect(
    parseLoggedGuestSteps('impd: e2e-bt-t0: booted pid 7\n', 'e2e-bt-t1', 'booted pid'),
  ).toStrictEqual({});
});

test('#parseLoggedSteps reads a log without the imp as no steps', () => {
  expect(
    parseLoggedSteps('impd: e2e-bt-t0: created in 48ms\n', 'e2e-bt-t1', 'created in'),
  ).toStrictEqual({});
});

test('#pickPercentile picks the nearest-rank value', () => {
  expect(pickPercentile([50, 10, 40, 20, 30], 0.5)).toBe(30);
});

test('#pickPercentile picks the largest value for the 95th of a few', () => {
  expect(pickPercentile([5, 1, 9], 0.95)).toBe(9);
});

test('#pickPercentile reads no values as 0', () => {
  expect(pickPercentile([], 0.5)).toBe(0);
});
