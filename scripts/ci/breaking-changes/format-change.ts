export function formatChange(path: string, what: string): string {
  return `${path === '' ? '' : ` ${path}`}: ${what}`;
}
