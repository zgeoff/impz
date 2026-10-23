import { $ } from 'bun';
import type { ShellExpression } from 'bun';

// Bun's shell breaks when it is called as a method, with another object as its this, so an I/O
// object holds this function in its place.
export function runBunShell(
  strings: TemplateStringsArray,
  ...expressions: ShellExpression[]
): $.ShellPromise {
  return $(strings, ...expressions);
}
