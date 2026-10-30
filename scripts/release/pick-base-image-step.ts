export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BaseImageFacts {
  readonly ref: string;
  readonly repository: string;
  readonly hasCheckScript: boolean;
  readonly dockerfile: string;
  inspected: CommandResult | null;
  verified: CommandResult | null;
}

export type BaseImageStep =
  | { readonly kind: 'inspect' }
  | { readonly kind: 'verify'; readonly digest: string }
  | { readonly kind: 'finish'; readonly action: 'push' | 'skip'; readonly notice: string | null }
  | { readonly kind: 'fail'; readonly stderr: string; readonly error: string | null };

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

// Every tag up to v0.27.0 has an unpinned images/base and no check script.
const pinnedBasePattern = /^ARG DOCKER_CE_VERSION=/mu;

// An existing tag without this repository's attestation may not be ours, and attesting it now would
// vouch for what nobody checked (docs/runbooks/releasing.md). A 401, a 403 or a network error from
// the registry never reads as a missing tag.
export function pickBaseImageStep(facts: BaseImageFacts): BaseImageStep {
  const ref = facts.ref;

  if (!facts.hasCheckScript || !pinnedBasePattern.test(facts.dockerfile)) {
    return {
      kind: 'finish',
      action: 'skip',
      notice: `this tree predates the published imp-base, so ${ref} is not built`,
    };
  }

  if (facts.inspected === null) {
    return { kind: 'inspect' };
  }

  if (facts.inspected.exitCode !== 0) {
    if (!facts.inspected.stderr.includes(`${ref}: not found`)) {
      return {
        kind: 'fail',
        stderr: `cannot tell whether ${ref} exists:\n${facts.inspected.stderr}`,
        error: null,
      };
    }

    return { kind: 'finish', action: 'push', notice: null };
  }

  const digest = facts.inspected.stdout.trim();

  if (!digestPattern.test(digest)) {
    return {
      kind: 'fail',
      stderr: '',
      error: `${ref} exists, but the registry gave no valid digest: ${digest}`,
    };
  }

  if (facts.verified === null) {
    return { kind: 'verify', digest };
  }

  if (facts.verified.exitCode !== 0) {
    return {
      kind: 'fail',
      stderr: `${facts.verified.stdout}${facts.verified.stderr}`,
      error: `${ref} exists at ${digest} with no attestation from ${facts.repository}; treat it as a possible compromise (docs/runbooks/releasing.md)`,
    };
  }

  return {
    kind: 'finish',
    action: 'skip',
    notice: `${ref} exists already at ${digest}, attested; a published imp-base never moves, so this run leaves it alone`,
  };
}
