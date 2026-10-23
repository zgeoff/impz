// Bun's fetch sends a loopback request through the shell's HTTP_PROXY or
// HTTPS_PROXY, and an older Bun keeps that proxy after the variable is deleted,
// so a NO_PROXY that matches every host turns it off
export function bypassAmbientProxy(): void {
  process.env['NO_PROXY'] = '*';
  process.env['no_proxy'] = '*';
}
