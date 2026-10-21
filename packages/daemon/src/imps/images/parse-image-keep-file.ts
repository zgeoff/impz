import { NameSchema } from '@impz/api';

export type ImageKeepFile =
  | { readonly isOk: true; readonly names: ReadonlySet<string> }
  | { readonly isOk: false; readonly reason: string };

export function parseImageKeepFile(text: string): ImageKeepFile {
  const names = new Set<string>();

  for (const [index, line] of text.split('\n').entries()) {
    const name = line.trim();

    if (name === '' || name.startsWith('#')) {
      continue;
    }

    if (!NameSchema.safeParse(name).success) {
      return {
        isOk: false,
        reason: `line ${String(index + 1)} holds ${JSON.stringify(name)}, which is no image name`,
      };
    }

    names.add(name);
  }

  return { isOk: true, names };
}
