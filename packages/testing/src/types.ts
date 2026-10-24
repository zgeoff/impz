import type { Duplex } from 'node:stream';
import type { ImpClient } from '@impz/client';

export interface TestImpdOptions {
  // impd settings, as the IMP_* variables impd reads at start
  readonly env?: Readonly<Record<string, string>>;
  readonly onLog?: (message: string) => void;
}

export interface TestImpd {
  // impd's API on a loopback port, for a client the test builds itself
  readonly url: string;
  readonly token: string;
  readonly client: ImpClient;
  readonly seedImage: (name: string) => Promise<void>;
  readonly startGuest: (impName: string) => Promise<TestGuest>;
  readonly fireTicker: (label: string) => Promise<void>;
  readonly stop: () => Promise<void>;
}

export interface TestGuest {
  // a process in the imp that dials a reverse forward's guest port
  readonly connect: (port: number) => Promise<Duplex>;
  readonly listPorts: () => readonly number[];
}
