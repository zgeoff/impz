export function readText(form: FormData, field: string): string | undefined {
  const value = form.get(field);

  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}

export function readInteger(form: FormData, field: string): number | undefined {
  const text = readText(form, field);

  return text === undefined ? undefined : Math.trunc(Number(text));
}
