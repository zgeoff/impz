export function isPeerAccept(rule: string): boolean {
  return (
    rule.includes('--comment imp-network') &&
    rule.includes('--mark 0x1000000/0x1000000') &&
    rule.endsWith('-j ACCEPT')
  );
}
