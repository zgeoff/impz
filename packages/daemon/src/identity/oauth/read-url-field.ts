export function readURLField(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) {
    return null;
  }

  const fields = new Map<string, unknown>(Object.entries(answer));

  const next: unknown = fields.get('url') ?? fields.get('redirect_uri');

  return typeof next === 'string' ? next : null;
}
