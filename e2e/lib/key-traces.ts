import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { utils } from 'ssh2';
import { runInContainer } from './instance';

export interface KeyPatterns {
  readonly text: string;

  readonly seedHex: string;
}

export function readKeyPatterns(keyPath: string): KeyPatterns {
  const file = readFileSync(keyPath, 'utf8');
  const parsed = utils.parseKey(file);

  if (parsed instanceof Error) {
    throw parsed;
  }

  const der = createPrivateKey(parsed.getPrivatePEM()).export({ type: 'pkcs8', format: 'der' });

  // grep matches within lines, so the seed pattern is the seed's longest run
  // of bytes without a newline.
  const runs = [...der.subarray(-32)]
    .map((byte) => (byte === 10 ? '|' : `\\x${byte.toString(16).padStart(2, '0')}`))
    .join('')
    .split('|');

  const seedHex = runs.toSorted((left, right) => right.length - left.length)[0] ?? '';

  return { text: file.split('\n')[3] ?? '', seedHex };
}

export interface KeyTraces {
  readonly control: boolean;
  readonly text: string;
  readonly seed: string;
}

export async function countKeyTraces(
  path: string,
  patterns: Readonly<KeyPatterns>,
  control: string,
): Promise<KeyTraces> {
  const count = async (flag: '-F' | '-P', pattern: string): Promise<string> => {
    // The disk and the memory file are sparse (a 32 GiB disk holds megabytes),
    // and tar -S reads only their data. LC_ALL=C: -P matches bytes, not UTF-8
    // characters.
    const script =
      'tar -cS -f - -C "$(dirname "$1")" "$(basename "$1")" | LC_ALL=C grep -c -a "$2" "$3"';

    const result = await runInContainer(['sh', '-c', script, 'sh', path, flag, pattern]);

    return result.stdout.trim();
  };

  const found = await count('-F', control);
  const text = await count('-F', patterns.text);
  const seed = await count('-P', patterns.seedHex);

  return { control: Number(found) > 0, text, seed };
}
