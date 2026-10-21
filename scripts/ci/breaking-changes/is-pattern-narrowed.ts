// A narrow pattern that is the wide one with one optional group made
// required matches only strings the wide one matches.
export function isPatternNarrowed(narrow: unknown, wide: unknown): boolean {
  if (typeof narrow !== 'string' || typeof wide !== 'string') {
    return false;
  }

  return collectOptionalGroups(wide).some((group) => {
    const before = wide.slice(0, group.start);
    const after = wide.slice(group.end + 2);
    const body = wide.slice(group.start + 3, group.end);

    return (
      narrow === `${before}(?:${body})${after}` ||
      (!group.hasAlternation && narrow === `${before}${body}${after}`)
    );
  });
}

interface OptionalGroup {
  // the index of its `(?:` and of its `)`, which a single `?` follows
  readonly start: number;
  readonly end: number;
  readonly hasAlternation: boolean;
}

interface OpenGroup {
  readonly start: number;
  hasAlternation: boolean;
}

function collectOptionalGroups(pattern: string): OptionalGroup[] {
  const groups: OptionalGroup[] = [];
  const open: OpenGroup[] = [];
  let inClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === '\\') {
      index += 1;
    } else if (inClass) {
      inClass = character !== ']';
    } else if (character === '[') {
      inClass = true;
    } else if (character === '(') {
      open.push({ start: index, hasAlternation: false });
    } else if (character === '|') {
      const innermost = open.at(-1);

      if (innermost !== undefined) {
        innermost.hasAlternation = true;
      }
    } else if (character === ')') {
      const group = open.pop();

      if (
        group !== undefined &&
        pattern.startsWith('(?:', group.start) &&
        pattern[index + 1] === '?' &&
        pattern[index + 2] !== '?'
      ) {
        groups.push({ start: group.start, end: index, hasAlternation: group.hasAlternation });
      }
    }
  }

  return groups;
}
