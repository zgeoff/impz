import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { IdentityTrustDocument } from '@impz/api';
import * as z from 'zod';
import type { TickerTimer } from '../../../platform/process/ticker';
import { buildIdentityToken } from './build-identity-token';
import type { IdentityImp } from './build-identity-token';
import { buildIdentityKey } from './identity-key';
import type { IdentityKey } from './identity-key';

type StageOutcome =
  | { readonly kind: 'staged' }
  | { readonly kind: 'already-staged' }
  | { readonly kind: 'not-in-future' };

export interface Identity {
  readonly issuer: string;

  readonly mintToken: (imp: IdentityImp, audience: string) => string;

  readonly readDocument: () => IdentityTrustDocument;

  // A staged change has no cancel: services already hold the `retire` entry.
  readonly stageKey: (atSeconds: number) => StageOutcome;

  // Cancels the timer that applies a staged switch.
  readonly stop: () => void;
}

export interface IdentityDeps {
  readonly directory: string;
  readonly issuer: string;
  readonly now: () => number;
  readonly timer?: TickerTimer | undefined;
}

interface StagedKey {
  readonly key: IdentityKey;
  readonly switchAtSeconds: number;
}

// A timer longer than this fires at once, so a far switch time waits in steps.
const MAX_TIMER_MS = 2 ** 30;

// impd signs with exactly one key at any time. The next key's private half
// sits on disk from the stage on, and at its switch time replaces key.pem,
// which deletes the old private key. A timer applies the switch on an idle impd.
export function loadOrCreateIdentity(deps: Readonly<IdentityDeps>): Identity {
  const paths = {
    key: join(deps.directory, 'key.pem'),
    next: join(deps.directory, 'next.pem'),
    nextTime: join(deps.directory, 'next.json'),
  };

  mkdirSync(deps.directory, { recursive: true, mode: 0o700 });
  chmodSync(deps.directory, 0o700);

  const state: { current: IdentityKey; next: StagedKey | null } = {
    current: readOrCreateKey(paths.key),
    next: readStagedKey(paths),
  };

  const readNowSeconds = (): number => Math.floor(deps.now() / 1000);
  const timer = deps.timer ?? startRuntimeTimer;
  const timerState: { cancel: (() => void) | null } = { cancel: null };

  // The caller reads the clock once and passes the value in, so the key that
  // is current and the time a token carries come from the same instant.
  const applyDueSwitch = (nowSeconds: number): void => {
    if (state.next === null || nowSeconds < state.next.switchAtSeconds) {
      return;
    }

    renameSync(paths.next, paths.key);
    rmSync(paths.nextTime, { force: true });

    state.current = state.next.key;
    state.next = null;
  };

  const scheduleSwitch = (): void => {
    timerState.cancel?.();
    timerState.cancel = null;

    if (state.next === null) {
      return;
    }

    const remainingMs = Math.max(state.next.switchAtSeconds * 1000 - deps.now(), 1);

    timerState.cancel = timer(
      'identity-key-switch',
      () => {
        applyDueSwitch(readNowSeconds());
        scheduleSwitch();

        return Promise.resolve();
      },
      Math.min(remainingMs, MAX_TIMER_MS),
    );
  };

  applyDueSwitch(readNowSeconds());
  scheduleSwitch();

  return {
    issuer: deps.issuer,

    mintToken: (imp, audience) => {
      const nowSeconds = readNowSeconds();

      applyDueSwitch(nowSeconds);

      return buildIdentityToken({
        key: state.current,
        issuer: deps.issuer,
        imp,
        audience,
        nowSeconds,
      });
    },

    readDocument: () => {
      applyDueSwitch(readNowSeconds());

      return buildDocument(deps.issuer, state.current, state.next);
    },

    stageKey: (atSeconds) => {
      const nowSeconds = readNowSeconds();

      applyDueSwitch(nowSeconds);

      if (state.next !== null) {
        return { kind: 'already-staged' };
      }

      if (atSeconds <= nowSeconds) {
        return { kind: 'not-in-future' };
      }

      const key = buildIdentityKey(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);

      writeKeyFile(paths.next, key);

      writeFileSync(paths.nextTime, JSON.stringify({ switchAtSeconds: atSeconds }), {
        mode: 0o600,
      });

      state.next = { key, switchAtSeconds: atSeconds };

      scheduleSwitch();

      return { kind: 'staged' };
    },

    stop: () => {
      timerState.cancel?.();
      timerState.cancel = null;
    },
  };
}

function readOrCreateKey(path: string): IdentityKey {
  if (existsSync(path)) {
    return buildIdentityKey(createPrivateKey(readFileSync(path, 'utf8')));
  }

  const key = buildIdentityKey(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);

  writeKeyFile(path, key);

  return key;
}

function writeKeyFile(path: string, key: IdentityKey): void {
  writeFileSync(path, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  chmodSync(path, 0o600);
}

const NextSchema = z.object({ switchAtSeconds: z.int().nonnegative() });

// A stage writes the key and then its time, so a key without a time is a stage
// that impd died in, and a time without a key is the end of a switch.
function readStagedKey(paths: Readonly<Record<'next' | 'nextTime', string>>): StagedKey | null {
  if (!existsSync(paths.next) || !existsSync(paths.nextTime)) {
    rmSync(paths.next, { force: true });
    rmSync(paths.nextTime, { force: true });

    return null;
  }

  const time = NextSchema.parse(JSON.parse(readFileSync(paths.nextTime, 'utf8')));

  return {
    key: buildIdentityKey(createPrivateKey(readFileSync(paths.next, 'utf8'))),
    switchAtSeconds: time.switchAtSeconds,
  };
}

function startRuntimeTimer(
  _label: string,
  run: () => Promise<void>,
  durationMs: number,
): () => void {
  const handle = setTimeout(() => {
    void run();
  }, durationMs);

  handle.unref();

  return () => {
    clearTimeout(handle);
  };
}

function buildDocument(
  issuer: string,
  current: IdentityKey,
  next: StagedKey | null,
): IdentityTrustDocument {
  return {
    issuer,
    keys: next === null ? [current.jwk] : [current.jwk, next.key.jwk],
    retire: next === null ? [] : [{ kid: current.jwk.kid, at: next.switchAtSeconds }],
  };
}
