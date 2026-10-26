import { expect, test } from 'bun:test';
import { pickRunTailnet } from './pick-run-tailnet';

test.each([
  ['tailscale', 'headscale'],
  ['moves-tailnet', 'headscale'],
  ['egress', 'headscale'],
  ['docker', 'off'],
] as const)('it joins the %s suite to the %s tailnet', (suite, expected) => {
  expect(pickRunTailnet([suite], {})).toBe(expected);
});

test('it leaves the names suite off the tailnet until its names are turned on', () => {
  expect(pickRunTailnet(['tailnet-names'], {})).toBe('off');
});

test('it joins the names suite to Tailscale once its names are turned on', () => {
  expect(pickRunTailnet(['tailnet-names'], { IMP_E2E_TAILNET_NAMES: '1' })).toBe('tailscale');
});

test('it joins Headscale for a run with the names suite while its names are off', () => {
  expect(pickRunTailnet(['tailscale', 'tailnet-names'], {})).toBe('headscale');
});

test('it refuses a run that needs both Headscale and Tailscale', () => {
  expect(() =>
    pickRunTailnet(['egress', 'tailnet-names'], { IMP_E2E_TAILNET_NAMES: '1' }),
  ).toThrowWithMessage(
    Error,
    'tailnet-names joins Tailscale and tailscale, moves-tailnet, egress join Headscale: run tailnet-names on its own',
  );
});
