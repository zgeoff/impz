// the key of one generation of an imp's logs
export function buildLogKey(impId: string, generation: string): string {
  return `${impId}/${generation}`;
}
