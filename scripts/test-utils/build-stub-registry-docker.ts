type StubRegistryAnswer =
  | { readonly kind: 'missing' }
  | { readonly kind: 'found'; readonly stdout: string }
  | { readonly kind: 'failed'; readonly error: string };

export function buildStubRegistryDocker(answer: StubRegistryAnswer): string {
  const answers = {
    missing: 'echo "ERROR: $4: not found" >&2; exit 1',
    found: answer.kind === 'found' ? `printf '%s\\n' ${buildShellWord(answer.stdout)}` : '',
    failed:
      answer.kind === 'failed' ? `printf '%s\\n' ${buildShellWord(answer.error)} >&2; exit 1` : '',
  };

  return `case "$1 $2 $3" in
  "buildx imagetools inspect") ${answers[answer.kind]} ;;
  *) exit 1 ;;
esac`;
}

function buildShellWord(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
