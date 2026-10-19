import type { ExposeResult } from '@impz/api';

// What an expose made, the credential included: impd shows it this once
export function formatExposeResult(result: ExposeResult): string {
  const lines = [`${result.url} is public`];

  if (result.auth === 'token') {
    lines.push(`token: ${result.credential ?? ''}`);
  }

  if (result.auth === 'basic') {
    lines.push(`user: ${result.user ?? ''}`, `password: ${result.credential ?? ''}`);
  }

  if (result.credential !== null) {
    lines.push('impd keeps only a hash; expose the imp again for a new one.');
  }

  if (result.warning !== undefined) {
    lines.push(`warning: ${result.warning}`);
  }

  return lines.join('\n');
}
