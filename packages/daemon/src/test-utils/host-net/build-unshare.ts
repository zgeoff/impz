interface BuildUnshareOptions {
  readonly mount: boolean;
  readonly uid: number | undefined;
}

export function buildUnshare(options: BuildUnshareOptions): string[] {
  // A user namespace under root would hide files an unmapped uid owns, such as
  // a CI runner's checkout under its home.
  const user = options.uid === 0 ? '' : 'r';
  const flags = `-${user}n${options.mount ? 'm' : ''}`;

  return options.mount ? ['unshare', flags, '--propagation', 'private'] : ['unshare', flags];
}
