// Bun's fetch sends even a unix-socket or loopback request through a proxy that
// the shell's HTTP_PROXY or HTTPS_PROXY names, and it keeps that proxy after the
// variable is deleted, so only a NO_PROXY that matches every host turns it off
export function bypassAmbientProxy(): void {
  process.env['NO_PROXY'] = '*';
  process.env['no_proxy'] = '*';
}
