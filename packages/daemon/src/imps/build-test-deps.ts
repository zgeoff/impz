import type { ImpdDeps } from '../create-impd';
import type { ImpDatabase } from '../db/open-database';
import type { StorageBackend } from '../storage/storage-backend';
import { readNoTailscale } from './read-no-tailscale';
import { TEST_TOKEN } from './test-token';

// what system.info reports about the guest kernel and the system drive
const TEST_SYSTEM_FILES = {
  guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
  systemDrive: { sha256: 'b'.repeat(64) },
};

// the freeze a checkpoint or a template asks of the guest; the fake VMs
// run no agent to ask
const NO_FREEZER = { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() };

// The boundaries a test impd reaches through createImpd's deps: the
// database, the clock, the log, and what the shim's recorders stand in for
export function buildTestDeps(
  ctx: Readonly<{
    db: ImpDatabase;
    dataDir: string;
    storage: StorageBackend;
    systemDrivePath: string;
    now: () => number;
    log: (message: string) => void;
    logRpcFailure: (failure: unknown) => void;
  }>,
): ImpdDeps {
  return {
    db: ctx.db,
    rootToken: TEST_TOKEN,
    storage: ctx.storage,
    systemFiles: {
      kernelPath: `${ctx.dataDir}/system/vmlinux`,
      systemDrivePath: ctx.systemDrivePath,
      info: TEST_SYSTEM_FILES,
    },
    log: ctx.log,
    logRpcFailure: ctx.logRpcFailure,
    now: ctx.now,
    readTailscale: readNoTailscale,
    freezer: NO_FREEZER,
  };
}
