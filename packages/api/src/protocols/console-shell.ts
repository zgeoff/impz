// Plain sh, because an image may have neither awk nor getent.
export const CONSOLE_SHELL = buildConsoleShell('/etc/passwd', ['/bin/bash', '/bin/sh']);

// The script holds each path unquoted, so a path must hold no quote or space.
/* @internal */
export function buildConsoleShell(passwdPath: string, fallbacks: readonly string[]): string {
  return [
    'uid=$(id -u 2>/dev/null) || uid=0',
    'shell=',
    'while IFS=: read -r _ _ id _ _ _ login; do',
    '  if [ "$id" = "$uid" ]; then shell=$login; break; fi',
    `done < ${passwdPath}`,
    ...fallbacks.map((fallback) => `[ -x "$shell" ] || shell=${fallback}`),
    'exec "$shell" -l',
  ].join('\n');
}
