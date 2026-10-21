// the Go agent's `imp-agent tar` parses this argv
export type TarCommand =
  | { readonly op: 'create'; readonly path: string }
  | { readonly op: 'extract'; readonly path: string; readonly owner?: string | undefined };

export function buildTarArgs(command: TarCommand): string[] {
  if (command.op === 'create') {
    return ['create', command.path];
  }

  return [
    'extract',
    ...(command.owner === undefined ? [] : ['--owner', command.owner]),
    command.path,
  ];
}
