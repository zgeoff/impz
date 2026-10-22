import { expect, test } from 'bun:test';
import { normalizeHost } from './normalize-host';

test.each([
  ['box.example.com', 'box.example.com'],
  ['Box.Example.COM', 'box.example.com'],
  ['box.example.com:8080', 'box.example.com'],
  ['box.example.com.', 'box.example.com'],
  ['box.example.com.:443', 'box.example.com'],
])('it writes the Host header %p as %p', (host, name) => {
  expect(normalizeHost(host)).toBe(name);
});

test.each([null, '[::1]', '[::1]:8080'])('it reads no host name from %p', (host) => {
  expect(normalizeHost(host)).toBeNull();
});
