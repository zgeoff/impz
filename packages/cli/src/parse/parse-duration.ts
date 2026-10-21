const UNIT_SECONDS: ReadonlyMap<string, number> = new Map([
  ['s', 1],
  ['m', 60],
  ['h', 3600],
  ['d', 86_400],
]);

export function parseDuration(text: string): number {
  const match = /^(?<amount>\d+)(?<unit>[smhd]?)$/u.exec(text.trim());
  const amount = match?.groups?.['amount'];
  const unit = match?.groups?.['unit'] ?? '';

  if (amount === undefined) {
    throw new Error(`not a duration: ${text} (try 90s, 15m, 2h)`);
  }

  return Number(amount) * (UNIT_SECONDS.get(unit) ?? 1);
}
