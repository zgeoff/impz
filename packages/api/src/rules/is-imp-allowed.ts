export function isImpAllowed(patterns: readonly string[] | null, name: string): boolean {
  return patterns === null || patterns.some((pattern) => isPatternMatch(pattern, name));
}

function isPatternMatch(pattern: string, name: string): boolean {
  const [first = '', ...rest] = pattern.split('*');

  if (rest.length === 0) {
    return name === first;
  }

  const last = rest.pop() ?? '';

  if (!name.startsWith(first) || !name.endsWith(last) || name.length < first.length + last.length) {
    return false;
  }

  let at = first.length;
  const end = name.length - last.length;

  for (const part of rest) {
    const found = name.indexOf(part, at);

    if (found === -1 || found + part.length > end) {
      return false;
    }

    at = found + part.length;
  }

  return true;
}
