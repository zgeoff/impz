// A word of these characters needs no quoting in a shell, a systemd unit or Nix's escapeShellArgs.
export const PLAIN_WORD = /^[\w@%+=:,./-]+$/u;
