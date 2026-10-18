import { expect, test } from 'bun:test';
import { formatExposeResult } from './format-expose-result';

test('#formatExposeResult says the URL is public when it made no credential', () => {
  const printed = formatExposeResult({
    url: 'https://web.imp.example.com',
    auth: 'none',
    user: null,
    credential: null,
  });

  expect(printed).toBe('https://web.imp.example.com is public');
});

test('#formatExposeResult prints the warning under the URL', () => {
  const printed = formatExposeResult({
    url: 'https://web.imp.example.com',
    auth: 'none',
    user: null,
    credential: null,
    warning: 'no record',
  });

  expect(printed).toBe('https://web.imp.example.com is public\nwarning: no record');
});

test('#formatExposeResult prints the user and the password it made', () => {
  const printed = formatExposeResult({
    url: 'https://web.imp.example.com',
    auth: 'basic',
    user: 'imp',
    credential: 'pw',
  });

  expect(printed).toBe(
    [
      'https://web.imp.example.com is public',
      'user: imp',
      'password: pw',
      'impd keeps only a hash; expose the imp again for a new one.',
    ].join('\n'),
  );
});
