import { expect, test } from 'bun:test';
import { checkReferenceRegistry } from './check-registry';

test.each([
  ['LocalHost/name', "registry LocalHost is the host's own"],
  ['LOCALHOST:5000/x', "registry LOCALHOST:5000 is the host's own"],
  ['Reg.LocalHost/x', "registry Reg.LocalHost is the host's own"],
  ['10.0.0.5:5000/y', 'registry 10.0.0.5:5000 is an IP address'],
  ['[::1]:5000/x', 'registry [::1]:5000 is an IP address'],
  ['[fe80::1]/x', 'registry [fe80::1] is an IP address'],
  ['169.254.169.254/x', 'registry 169.254.169.254 is an IP address'],
])('it names the refused registry of %s', (reference, problem) => {
  expect(checkReferenceRegistry(reference)).toBe(problem);
});

test('it passes a named registry', () => {
  expect(checkReferenceRegistry('ghcr.io/x')).toBeNull();
});

test('it passes Docker Hub', () => {
  expect(checkReferenceRegistry('alpine')).toBeNull();
});
