import { UsageError } from '../cli/errors';

export const DEFAULT_DETACH_KEY = 'ctrl-]';
export const DEFAULT_SESSION = 'main';

// ctrl-[ is Escape, and ctrl-h, ctrl-i, ctrl-j and ctrl-m are Backspace,
// Tab, Enter and Return, which a program needs
const RESERVED_KEYS = new Set(['[', 'h', 'i', 'j', 'm']);

// a terminal sends ctrl-<key> as the key's code with the top three bits
// cleared, so ctrl-] is 0x1d and ctrl-a is 0x01
export function parseDetachKey(text: string): number | null {
  if (text === 'none') {
    return null;
  }

  const key = /^ctrl-(?<key>[a-z@[\\\]^_])$/iu.exec(text)?.groups?.['key']?.toLowerCase();

  if (key === undefined || RESERVED_KEYS.has(key)) {
    throw new UsageError(
      `--detach-key takes ctrl-<key> (a-z but h, i, j and m; @, \\, ], ^ or _) or none, got ${text}`,
    );
  }

  return (key.toUpperCase().codePointAt(0) ?? 0) & 0x1f;
}

export interface DetachKeyMatch {
  readonly at: number;
  readonly length: number;
}

// a terminal sends ctrl-<key> as CSI cp;5u under the kitty keyboard protocol
// and as CSI 27;5;cp~ under xterm's modifyOtherKeys, when a program turned
// either on
export function findDetachKey(chunk: Uint8Array, key: number): DetachKeyMatch | null {
  const codepoint = String(getKeyCodepoint(key));

  const text = new TextDecoder('latin1').decode(chunk);

  const matches = [
    { at: chunk.indexOf(key), length: 1 },
    ...[`\u001B[${codepoint};5u`, `\u001B[27;5;${codepoint}~`].map((form) => ({
      at: text.indexOf(form),
      length: form.length,
    })),
  ].filter((match) => match.at !== -1);

  if (matches.length === 0) {
    return null;
  }

  return matches.reduce((first, match) => (match.at < first.at ? match : first));
}

// kitty reports a ctrl letter by its lower-case codepoint
function getKeyCodepoint(key: number): number {
  return key >= 0x01 && key <= 0x1a ? 0x60 + key : 0x40 + key;
}
