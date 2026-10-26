import { parseZfsPoolProperties } from '../../../scripts/lib/parse-zfs-pool-properties.ts';

// -o words are pool properties, which zpool reads back, and -O words the pool's root dataset's,
// which zfs reads back.
interface PoolProperty {
  readonly tool: 'zpool' | 'zfs';
  readonly name: string;
  readonly value: string;
}

type PoolPropertiesRead =
  | { readonly kind: 'read'; readonly properties: readonly PoolProperty[] }
  | { readonly kind: 'refused'; readonly reason: string };

export function readPoolProperties(
  path: string,
  readText: (path: string) => string,
): PoolPropertiesRead {
  let text: string;

  try {
    text = readText(path);
  } catch (error) {
    return refuse(`cannot read the pool properties from ${path}: ${String(error)}`);
  }

  let words: readonly string[];

  try {
    words = parseZfsPoolProperties(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return refuse(reason);
  }

  return parseCreateWords(path, words);
}

function refuse(reason: string): PoolPropertiesRead {
  return { kind: 'refused', reason };
}

const FLAG_TOOLS = new Map<string, PoolProperty['tool']>([
  ['-o', 'zpool'],
  ['-O', 'zfs'],
]);

function parseCreateWords(path: string, words: readonly string[]): PoolPropertiesRead {
  const properties: PoolProperty[] = [];

  for (let index = 0; index < words.length; index += 2) {
    const flag = words[index];
    const property = words[index + 1] ?? '';
    const separator = property.indexOf('=');
    const tool = flag === undefined ? undefined : FLAG_TOOLS.get(flag);

    if (tool === undefined || separator <= 0) {
      return refuse(
        `${path} gives zpool create ${String(flag)} ${property}, not -o or -O name=value`,
      );
    }

    properties.push({
      tool,
      name: property.slice(0, separator),
      value: property.slice(separator + 1),
    });
  }

  return { kind: 'read', properties };
}
