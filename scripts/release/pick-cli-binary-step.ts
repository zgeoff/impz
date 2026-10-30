export interface CLIBinaryFacts {
  readonly target: string;
  readonly version: string;
  readonly distFiles: readonly string[];
  readonly sums: string;
  binarySum: string | null;
  reported: string | null;
}

export type CLIBinaryStep =
  | { readonly kind: 'hash'; readonly name: string }
  | { readonly kind: 'ask-version'; readonly name: string }
  | {
      readonly kind: 'check-completions';
      readonly name: string;
      readonly shells: readonly string[];
      readonly message: string;
    }
  | { readonly kind: 'fail'; readonly message: string };

// The Homebrew formula generates these completions at install time.
const completionShells = ['bash', 'zsh', 'fish'];

export function pickCLIBinaryStep(facts: CLIBinaryFacts): CLIBinaryStep {
  const renamed = `impz-${facts.target}`;

  // a tag from before the CLI's rename builds imp-<target>
  const name = facts.distFiles.includes(renamed) ? renamed : `imp-${facts.target}`;

  if (!facts.distFiles.includes(name)) {
    return {
      kind: 'fail',
      message: `dist/ holds neither impz-${facts.target} nor imp-${facts.target}`,
    };
  }

  if (facts.binarySum === null) {
    return { kind: 'hash', name };
  }

  const listed = facts.sums
    .split('\n')
    .find((line) => line.endsWith(`  ${name}`))
    ?.split('  ')[0];

  if (listed !== facts.binarySum) {
    return {
      kind: 'fail',
      message: `${name} has sha256 ${facts.binarySum}, and SHA256SUMS lists ${listed ?? 'no sum'} for it`,
    };
  }

  if (facts.reported === null) {
    return { kind: 'ask-version', name };
  }

  const reported = facts.reported.trim();

  if (reported !== facts.version) {
    return { kind: 'fail', message: `${name} --version is ${reported}, want ${facts.version}` };
  }

  return {
    kind: 'check-completions',
    name,
    shells: completionShells,
    message: `${name} is ${facts.version}, matches SHA256SUMS and prints its completions`,
  };
}
