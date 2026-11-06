import { expect, test } from 'bun:test';
import { buildMockOperation } from './build-mock-operation';

test('it builds a running operation with no steps', () => {
  const operation = buildMockOperation();

  expect(operation).toStrictEqual(
    expect.objectContaining({ state: 'running', ending: null, cancelRequested: false, steps: [] }),
  );
});

test('it keeps the fields the caller gives', () => {
  const operation = buildMockOperation({ state: 'queued', cancelRequested: true });

  expect(operation).toStrictEqual(
    expect.objectContaining({ state: 'queued', cancelRequested: true }),
  );
});
