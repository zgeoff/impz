import type { Duplex } from 'node:stream';
import type { ImpClient } from '@impz/client';

export interface TestImpdOptions {
  // impd settings, as the IMP_* variables impd reads at start
  readonly env?: Readonly<Record<string, string>>;
  readonly onLog?: (message: string) => void;

  // the version that system.info and system.features report, so a client's outdated-impd branch runs
  readonly version?: string;

  // merged into the features that system.features reports
  readonly features?: Readonly<Record<string, boolean>>;
}

// an oRPC defined error, as impd answers a refused call
export interface DefinedFault {
  readonly code: string;
  readonly status: number;
  readonly message?: string;
  readonly data?: unknown;
}

// a raw answer that is no oRPC error, or an oRPC error with `defined: false`
export interface RawFault {
  readonly status: number;
  readonly body: unknown;
}

export interface FailOptions {
  // how many calls the fault answers before it goes away; every call when left out
  readonly times?: number;

  // narrows the fault to the calls whose decoded input it accepts
  readonly when?: (input: unknown) => boolean;
}

export interface FaultHandle {
  readonly clear: () => void;
}

// the error frame that impd sends on an exec WebSocket
export interface ExecRefusal {
  readonly code: string;
  readonly message: string;
  readonly data?: unknown;
}

export interface RecordedCall {
  readonly procedure: string;
  readonly input: unknown;

  // the Authorization header as the client sent it, such as `Bearer <token>`
  readonly authorization: string | null;
}

export interface TestImpd {
  // the fault proxy's API on a loopback port, for a client the test builds itself
  readonly url: string;

  // impd's own API, which bypasses the proxy
  readonly impdUrl: string;
  readonly client: ImpClient;
  readonly seedImage: (name: string) => Promise<void>;
  readonly startGuest: (impName: string) => Promise<TestGuest>;
  readonly fireTicker: (label: string) => Promise<void>;
  readonly stop: () => Promise<void>;

  // answers the next calls to a procedure, such as `imps/sleep`, with a fault in place of impd
  readonly fail: (
    procedure: string,
    answer: DefinedFault | RawFault,
    options?: FailOptions,
  ) => FaultHandle;

  // leaves matching calls with no answer until the client aborts or the test stops impd
  readonly stall: (procedure: string) => FaultHandle;
  readonly clearFaults: () => void;

  // destroys every open socket at once, with no close frame
  readonly dropConnections: () => void;

  // holds every byte in both directions, with no FIN, until thaw
  readonly freeze: () => void;
  readonly thaw: () => void;

  // answers the next exec WebSocket with impd's error frame, then closes it
  readonly refuseExec: (error: ExecRefusal) => void;

  // closes each open tunnel control socket with that close code
  readonly closeTunnels: (code: number, reason: string) => void;

  // each oRPC call the proxy forwarded or faulted, in order; the array grows as calls arrive
  readonly calls: readonly RecordedCall[];
}

export interface TestGuest {
  // a process in the imp that dials a reverse forward's guest port
  readonly connect: (port: number) => Promise<Duplex>;
}
