// tailscale up takes an OAuth client secret as an auth key; the suffix makes each node ephemeral
// and preauthorized.
export function toEphemeralKey(secret: string): string {
  return `${secret.split('?')[0] ?? ''}?ephemeral=true&preauthorized=true`;
}
