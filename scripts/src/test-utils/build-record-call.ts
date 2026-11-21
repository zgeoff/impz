import { join } from 'node:path';
import { formatShellWord } from '@impz/shared/test-utils/format-shell-word';

interface RecordCallOptions {
  // the command the call is recorded under
  readonly name: string;

  // the calls.jsonl of the folder that holds the kit's stand-ins
  readonly callsFile: string;

  // variables to record with the call, empty when unset
  readonly recordEnv?: readonly string[] | undefined;

  // what the call's argument is, as bash words; the script's own arguments when it is left out
  readonly args?: string;
}

// bash that appends a call to the kit's calls.jsonl, in the form readStubCalls reads, so a script
// that cannot be a kit stand-in is listed among the calls of the kit's stand-ins.
export function buildRecordCall(options: Readonly<RecordCallOptions>): string {
  const variables = (options.recordEnv ?? []).map((name) => formatShellWord(name));
  const source = formatShellWord(join(import.meta.dir, 'record-call.sh'));

  const words = [
    'record_call',
    formatShellWord(options.name),
    formatShellWord(options.callsFile),
    ...variables,
    '--',
    options.args ?? '"$@"',
  ];

  return `. ${source}\n${words.join(' ')}`;
}
