import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRecordCall } from './build-record-call';

interface StubRepoScriptOptions {
  // runs after the call is recorded, with the arguments the script was given
  readonly body?: string;

  // variables to record with each call, empty when unset
  readonly recordEnv?: readonly string[];
}

// Writes a stand-in for one of the repo's scripts, which a test reaches by path. It records each
// call in the calls.jsonl of the folder `stubs` that holds the kit's stand-ins, so readStubCalls
// lists the script's calls among theirs.
export function createStubRepoScript(
  scripts: string,
  name: string,
  stubs: string,
  options: Readonly<StubRepoScriptOptions> = {},
): string {
  const file = join(scripts, name);

  mkdirSync(stubs, { recursive: true });

  const record = buildRecordCall({
    name,
    callsFile: join(stubs, 'calls.jsonl'),
    recordEnv: options.recordEnv,
  });

  writeFileSync(file, `#!/bin/bash\n${record}\n${options.body ?? ''}\n`);
  chmodSync(file, 0o755);

  return file;
}
