// Bun's fetch sends a loopback request through the shell's HTTP_PROXY or
// HTTPS_PROXY. Bun 1.4.2 keeps that proxy after the variable is deleted and 1.4.3
// follows the delete, so a NO_PROXY that matches every host turns it off on both
export function bypassAmbientProxy(): void {
  process.env['NO_PROXY'] = '*';
  process.env['no_proxy'] = '*';
}
