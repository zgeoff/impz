import { randomUUID } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { PROXY_VARIABLE } from '../../../imps/exec/broker-exec-env';
import type { StartTimer } from '../../../platform/process/clock';
import { getErrorMessage } from '../../../platform/process/get-error-message';
import { getImpdLogger } from '../../../platform/process/get-impd-logger';
import { buildExitError } from '../../../platform/process/run-command';
import { startRealTimer } from '../../../platform/process/start-real-timer';
import { openExecStream } from '../../../vm/agent-client/exec-stream';
import installScript from './install-broker-ca.sh' with { type: 'text' };

const GUEST_BUNDLE_PATH = '/etc/imp/broker-ca.pem';

// where distros keep their root bundle: Debian, Ubuntu, Alpine and Arch;
// Fedora and RHEL; openSUSE; the BSD-style name some images use
const GUEST_ROOT_PATHS = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/ssl/cert.pem',
];

const ROOTS_MARKER = '# imp: host roots';

const CA_VARIABLES = [
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
];

const INSTALL_TIMEOUT_MS = 10_000;

export interface BrokerEnvInput {
  readonly proxyUrl: string;
  readonly placeholders: readonly string[];
  readonly placeholder: string;
}

export function buildBrokerEnv(input: BrokerEnvInput): readonly string[] {
  const local = 'localhost,127.0.0.1,::1';

  // both spellings, since tools disagree on which they read
  return [
    `${PROXY_VARIABLE}=${input.proxyUrl}`,
    `https_proxy=${input.proxyUrl}`,
    `NO_PROXY=${local}`,
    `no_proxy=${local}`,

    // Node's own fetch reads the proxy variables only with this set
    'NODE_USE_ENV_PROXY=1',
    ...CA_VARIABLES.map((name) => `${name}=${GUEST_BUNDLE_PATH}`),
    ...input.placeholders.map((name) => `${name}=${input.placeholder}`),
  ];
}

export function buildInstallInput(caPem: string): string {
  return `${caPem.trim()}\n${ROOTS_MARKER}\n${rootCertificates.join('\n')}\n`;
}

/* @internal */
export function buildInstallArgv(
  target = GUEST_BUNDLE_PATH,
  rootPaths: readonly string[] = GUEST_ROOT_PATHS,
): string[] {
  // each path goes to the script as an argument, never into its text
  return ['/bin/sh', '-c', installScript, 'install-broker-ca', target, ROOTS_MARKER, ...rootPaths];
}

export interface TrustedImp {
  readonly id: string;
  readonly name: string;

  readonly pid: number | null;
}

export type InstallBundle = (vsockPath: string, input: string) => Promise<void>;

type TrustOutcome =
  | { readonly installed: true }
  | { readonly installed: false; readonly detail: string };

export interface GuestTrust {
  readonly ensure: (imp: TrustedImp, vsockPath: string) => Promise<TrustOutcome>;

  readonly observe: (imp: Readonly<TrustedImp & { readonly state: string }>) => void;

  readonly forgetExcept: (impIds: ReadonlySet<string>) => void;
}

interface Boot {
  readonly pid: number | null;
  readonly id: string;
}

export function createGuestTrust(input: string, install: InstallBundle): GuestTrust {
  // a boot is an ID impd mints, not the pid, which the kernel can hand out
  // again: the same pid after a stop, sleep or halt is a new boot
  const boots = new Map<string, Boot>();
  const installs = new Map<string, { readonly boot: string; done: Promise<TrustOutcome> }>();

  const readBoot = (imp: TrustedImp): Boot => {
    const known = boots.get(imp.id);

    if (known !== undefined && known.pid === imp.pid) {
      return known;
    }

    const boot = { pid: imp.pid, id: randomUUID() };

    boots.set(imp.id, boot);

    return boot;
  };

  const removeImp = (impId: string): void => {
    boots.delete(impId);
    installs.delete(impId);
  };

  return {
    ensure: (imp, vsockPath) => {
      const boot = readBoot(imp);
      const known = installs.get(imp.id);

      if (known?.boot === boot.id) {
        return known.done;
      }

      const entry = {
        boot: boot.id,
        done: Promise.resolve<TrustOutcome>({
          installed: false,
          detail: 'the install has not run',
        }),
      };

      const runInstall = async (): Promise<TrustOutcome> => {
        try {
          await install(vsockPath, input);

          return { installed: true };
        } catch (error) {
          const detail = getErrorMessage(error);

          getImpdLogger('imps')
            .with({ imp: imp.name })
            .warning('broker CA not installed, so this exec gets no broker variables: {detail}', {
              detail,
            });

          if (installs.get(imp.id) === entry) {
            installs.delete(imp.id);
          }

          return { installed: false, detail };
        }
      };

      entry.done = runInstall();

      installs.set(imp.id, entry);

      return entry.done;
    },
    observe: (imp) => {
      if (imp.pid === null || imp.state !== 'running') {
        removeImp(imp.id);

        return;
      }

      readBoot(imp);
    },
    forgetExcept: (impIds) => {
      for (const id of boots.keys()) {
        if (!impIds.has(id)) {
          removeImp(id);
        }
      }

      for (const id of installs.keys()) {
        if (!impIds.has(id)) {
          removeImp(id);
        }
      }
    },
  };
}

interface BundleInstallOptions {
  readonly timeoutMs?: number;

  readonly startTimer?: StartTimer;
}

export async function runBundleInstall(
  vsockPath: string,
  input: string,
  options: Readonly<BundleInstallOptions> = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const startTimer = options.startTimer ?? startRealTimer;

  const stream = await openExecStream(vsockPath, {
    argv: buildInstallArgv(),
    tty: false,

    // uid 0 needs no passwd entry in the guest
    user: '0',
  });

  const state = { cut: false };

  const cancelTimer = startTimer(() => {
    state.cut = true;

    stream.close();
  }, timeoutMs);

  try {
    stream.writeStdin(new TextEncoder().encode(input));
    stream.closeStdin();

    const stderr: string[] = [];

    for await (const event of stream.events()) {
      if (event.type === 'stderr') {
        stderr.push(new TextDecoder().decode(event.data));
      } else if (event.type === 'exit') {
        if (event.code !== 0 || event.signal !== 0) {
          throw buildExitError(['the install'], { exitCode: event.code, stderr: stderr.join('') });
        }

        return;
      }
    }

    const ended = state.cut
      ? `the install did not finish within ${String(timeoutMs)} ms`
      : 'the install ended without an exit';

    throw new Error(ended);
  } finally {
    cancelTimer();

    stream.close();
  }
}
