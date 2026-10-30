// A step script takes its inputs from the step's env:, so a name the step leaves out is a fault in
// the workflow, and an empty value, such as a dry run's tag, is an input.
export function getStepEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];

  if (value === undefined) {
    throw new Error(`the step sets no ${name} in its env`);
  }

  return value;
}
