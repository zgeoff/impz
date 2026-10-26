import type { HarnessEnv } from './config';

export type RunTailnetKind = 'off' | 'headscale' | 'tailscale';

const HEADSCALE_SUITES: readonly string[] = ['tailscale', 'moves-tailnet', 'egress'];

// One tailscaled joins one control server, so a run joins Headscale or
// Tailscale, never both.
export function pickRunTailnet(suites: readonly string[], env: HarnessEnv): RunTailnetKind {
  const isHeadscale = suites.some((suite) => HEADSCALE_SUITES.includes(suite));
  const isTailscale = suites.includes('tailnet-names') && env['IMP_E2E_TAILNET_NAMES'] === '1';

  if (isHeadscale && isTailscale) {
    throw new Error(
      `tailnet-names joins Tailscale and ${HEADSCALE_SUITES.join(', ')} join Headscale: run tailnet-names on its own`,
    );
  }

  if (isHeadscale) {
    return 'headscale';
  }

  return isTailscale ? 'tailscale' : 'off';
}
