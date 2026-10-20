import { LAYER_TABLE } from './plan-layer-path';

const MOVES_BY_TARGET = Object.entries(LAYER_TABLE.moves).toSorted(
  ([, a], [, b]) => b.length - a.length,
);

// the path under src that a placed `path` had before the move, or `path` itself when no move
// placed it
export function planOriginalLayerPath(path: string): string {
  const move = MOVES_BY_TARGET.find(
    ([, target]) =>
      path === target || path.startsWith(`${target}/`) || path.startsWith(`${target}.`),
  );

  if (move === undefined) {
    return path;
  }

  const [stem, target] = move;

  return `${stem}${path.slice(target.length)}`;
}
