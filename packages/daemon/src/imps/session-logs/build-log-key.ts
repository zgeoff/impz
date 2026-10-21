export function buildLogKey(impId: string, generation: string): string {
  return `${impId}/${generation}`;
}
