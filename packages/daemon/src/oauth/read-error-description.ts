// better-auth's error_description in a JSON refusal, or null
export function readErrorDescription(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) {
    return null;
  }

  const fields = new Map<string, unknown>(Object.entries(answer));

  const description = fields.get('error_description');

  return typeof description === 'string' ? description : null;
}
