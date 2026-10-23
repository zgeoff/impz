import { readFileSync } from 'node:fs';
import * as z from 'zod';

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

const PoolFileSchema = z.object({ create: z.array(z.string()) });

export function readPoolProperties(path: string): PoolPropertiesRead {
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return refuse(`cannot read the pool properties from ${path}: ${String(error)}`);
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch (error) {
    return refuse(`cannot read the pool properties from ${path}: ${String(error)}`);
  }

  const file = PoolFileSchema.safeParse(json);

  if (!file.success) {
    return refuse(`cannot read the pool properties from ${path}: ${file.error.message}`);
  }

  if (file.data.create.length === 0) {
    return refuse(`${path} gives zpool create no properties`);
  }

  return parseCreateWords(path, file.data.create);
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
