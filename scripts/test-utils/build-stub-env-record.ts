export function buildStubEnvRecord(variables: readonly string[]): string {
  const values = variables.map((variable) => `${variable}=\${${variable}-}`).join(' ');

  return `printf '%s\\n' "  ${values}" >>"$STUB_CALLS"`;
}
