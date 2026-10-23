import { expect, mock, test } from 'bun:test';
import { createSocketRegistry } from './create-socket-registry';

test('it closes every socket it holds with the code and reason given', () => {
  const registry = createSocketRegistry<string>();
  const closeFirst = mock();
  const closeSecond = mock();

  registry.add('a', { session: 'first', close: closeFirst, forget: () => {} });
  registry.add('b', { session: 'second', close: closeSecond, forget: () => {} });
  registry.closeAll(1012, 'impd is restarting');

  expect(closeFirst).toHaveBeenCalledExactlyOnceWith(1012, 'impd is restarting');
  expect(closeSecond).toHaveBeenCalledExactlyOnceWith(1012, 'impd is restarting');
});

test('it finds the session of a socket it holds', () => {
  const registry = createSocketRegistry<string>();

  registry.add('a', { session: 'first', close: () => {}, forget: () => {} });

  expect(registry.findSession('a')).toBe('first');
});

test('it forgets a removed socket and stops its revocation watch', () => {
  const registry = createSocketRegistry<string>();
  const forget = mock();

  registry.add('a', { session: 'first', close: () => {}, forget });

  const removed = registry.remove('a');

  expect(removed?.session).toBe('first');
  expect(forget).toHaveBeenCalledOnce();
  expect(registry.findSession('a')).toBeUndefined();
});

test('it leaves a removed socket open on a later close of all', () => {
  const registry = createSocketRegistry<string>();
  const close = mock();

  registry.add('a', { session: 'first', close, forget: () => {} });
  registry.remove('a');
  registry.closeAll(1012, 'impd is restarting');

  expect(close).not.toHaveBeenCalled();
});

test('it answers a removal of a socket it never held with nothing', () => {
  const registry = createSocketRegistry<string>();

  expect(registry.remove('a')).toBeUndefined();
});
