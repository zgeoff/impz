interface SourcedFunctionCall {
  readonly script: string;
  readonly fn: string;
  readonly args?: readonly string[];
  readonly stdin?: string;

  // The child inherits only PATH from this process, so none of its tokens reach the script.
  readonly env?: Readonly<Record<string, string>>;
}

export interface SourcedFunctionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runSourcedFunction(call: SourcedFunctionCall): SourcedFunctionResult {
  const result = Bun.spawnSync(
    ['bash', '-c', 'source "$1"; shift; "$@"', 'bash', call.script, call.fn, ...(call.args ?? [])],
    {
      env: { PATH: process.env['PATH'] ?? '', ...call.env },
      stdin: Buffer.from(call.stdin ?? ''),
    },
  );

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
