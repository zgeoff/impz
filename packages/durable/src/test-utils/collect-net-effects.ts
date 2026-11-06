export function collectNetEffects(effects: readonly string[]): string[] {
  const kept = new Set<string>();

  for (const effect of effects) {
    if (effect.startsWith('undo ')) {
      kept.delete(effect.slice('undo '.length));
    } else {
      kept.add(effect);
    }
  }

  return [...kept];
}
