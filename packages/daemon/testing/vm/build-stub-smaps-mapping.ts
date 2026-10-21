interface SmapsMappingOptions {
  readonly start: number;
  readonly mib: number;

  readonly perms: string;

  readonly flags: string;

  readonly backing?: string;
}

// The kernel's show_smap_vma_flags prints VmFlags in permission order: rd, wr,
// ex, sh, then mr, mw, me; ac marks a private writable mapping.
export function buildStubSmapsMapping(options: Readonly<SmapsMappingOptions>): string {
  const end = options.start + options.mib * 1024 ** 2;
  const header = `${options.start.toString(16)}-${end.toString(16)} ${options.perms} 00000000 00:00 0 ${options.backing ?? ''}`;
  const [read, write, exec, share] = options.perms;

  const vmFlags = [
    read === 'r' ? 'rd' : '',
    write === 'w' ? 'wr' : '',
    exec === 'x' ? 'ex' : '',
    share === 's' ? 'sh' : '',
    'mr mw me',
    write === 'w' && share === 'p' ? 'ac' : '',
    options.flags,
  ].filter((flag) => flag !== '');

  return [header.trimEnd(), 'Rss:                 100 kB', `VmFlags: ${vmFlags.join(' ')}`].join(
    '\n',
  );
}
