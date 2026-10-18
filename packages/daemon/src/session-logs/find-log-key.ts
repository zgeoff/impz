// the key of one generation of an imp's logs
export function findLogKey(impId: string, generation: string): string {
  return `${impId}/${generation}`;
}
