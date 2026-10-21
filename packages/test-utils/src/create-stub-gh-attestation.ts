import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface StubGhAttestationOptions {
  readonly bin: string;
  readonly loggedIn: boolean;
  readonly verifies: boolean;
}

export interface StubGhAttestation {
  readonly readCalls: () => readonly string[];
}

export function createStubGhAttestation(options: StubGhAttestationOptions): StubGhAttestation {
  const log = join(options.bin, 'gh.calls');
  const authStatus = options.loggedIn ? '0\n' : '1\n';
  const attestation = options.verifies ? '0\n' : '1\n';

  writeFileSync(log, '');
  writeFileSync(join(options.bin, 'gh.auth-status'), authStatus);
  writeFileSync(join(options.bin, 'gh.attestation'), attestation);
  copyFileSync(join(import.meta.dir, 'run-stub-gh-attestation.sh'), join(options.bin, 'gh'));
  chmodSync(join(options.bin, 'gh'), 0o755);

  return {
    readCalls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
  };
}
