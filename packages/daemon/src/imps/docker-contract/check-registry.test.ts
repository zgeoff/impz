import { expect, test } from 'bun:test';
import { checkReferenceRegistry, checkRegistry } from './check-registry';

test.each([
  ['LocalHost/name', "registry LocalHost is the host's own"],
  ['LOCALHOST:5000/x', "registry LOCALHOST:5000 is the host's own"],
  ['Reg.LocalHost/x', "registry Reg.LocalHost is the host's own"],
  ['10.0.0.5:5000/y', 'registry 10.0.0.5:5000 is an IP address'],
])('#checkReferenceRegistry names the refused registry of %s', (reference, problem) => {
  expect(checkReferenceRegistry(reference)).toBe(problem);
});

test('#checkReferenceRegistry passes a named registry', () => {
  expect(checkReferenceRegistry('ghcr.io/x')).toBeNull();
});

test.each([
  ['[::1]:5000', 'registry [::1]:5000 is an IP address'],
  ['[fe80::1]', 'registry [fe80::1] is an IP address'],
  ['169.254.169.254', 'registry 169.254.169.254 is an IP address'],
])('#checkRegistry refuses the IP literal registry %s', (registry, problem) => {
  expect(checkRegistry(registry)).toBe(problem);
});

test('#checkRegistry passes Docker Hub', () => {
  expect(checkRegistry('docker.io')).toBeNull();
});
