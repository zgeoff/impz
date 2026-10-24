import type { OAuthConfig } from '@impz/api';
import type { ImpDatabase } from '../../../platform/db/open-database';
import { listSecrets, readSecret } from '../../../platform/db/secrets';
import type { SecretRecord } from '../../../platform/db/secrets';
import { sendWithCA } from '../../../platform/http/send-with-ca';
import { buildBackoffMs } from '../../../platform/process/build-backoff-ms';
import { getErrorMessage } from '../../../platform/process/get-error-message';
import { buildKeyedMutex } from '../../../platform/process/keyed-mutex';
import { createSingleFlight } from '../../../platform/process/single-flight';
import { startTicker } from '../../../platform/process/ticker';
import type { Ticker, TickerTimer } from '../../../platform/process/ticker';
import type { ResolveUpstream } from '../tls/forward-request';
import { isDue } from './is-due';
import { formatOAuthState, parseOAuthState, readJwtExpiry } from './oauth-state';
import type { OAuthStateFile } from './oauth-state';
import { parseTokenAnswer } from './parse-token-answer';
import type { Classified, TokenResponse } from './parse-token-answer';
import type { SecretFiles } from './secret-files';

interface OAuthRequest {
  readonly method: 'POST';
  readonly headers: Headers;
  readonly body: string;
  readonly redirect: 'manual';
  readonly signal: AbortSignal;
  readonly tls?: { readonly ca: readonly string[] };
}

export type OAuthFetch = (url: string, init: OAuthRequest) => Promise<Response>;

type RefreshOutcome =
  | { readonly kind: 'refreshed'; readonly rotated: boolean }
  | { readonly kind: 'transient'; readonly error: string }
  | { readonly kind: 'needs-login'; readonly error: string }
  | { readonly kind: 'dropped' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'skipped' };

export interface OAuthRefresher {
  readonly refresh: (name: string, force: boolean) => Promise<RefreshOutcome>;

  readonly refreshAfterRejection: (name: string, refreshedAt: number | null) => Promise<boolean>;

  readonly withLock: <T>(name: string, work: () => Promise<T>) => Promise<T>;

  readonly tick: () => Promise<void>;

  readonly start: () => void;
  readonly stop: () => Promise<void>;
}

interface OAuthRefresherDeps {
  readonly db: ImpDatabase;
  readonly files: Pick<SecretFiles, 'read' | 'rewrite'>;
  readonly log: (message: string) => void;
  readonly resolveUpstream: ResolveUpstream;
  readonly fetch?: OAuthFetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly timer?: TickerTimer | undefined;
}

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;
const REJECTION_FLOOR_MS = 5 * 60_000;

export function createOAuthRefresher(deps: OAuthRefresherDeps): OAuthRefresher {
  const now = deps.now ?? Date.now;
  const send = deps.fetch ?? sendWithCA;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const log = deps.log;
  const locks = buildKeyedMutex();
  const inflight = createSingleFlight<RefreshOutcome>();

  const backoff = new Map<string, { failures: number; nextAt: number }>();

  // a result whose write failed is kept: a rotated refresh token in it may be
  // the only live one
  const unsaved = new Map<string, { valueFile: string; state: OAuthStateFile }>();

  const lifecycle = { stopping: false };
  const timer: { ticker: Ticker | null } = { ticker: null };
  const withLock = locks.runExclusive;

  const writeState = (
    name: string,
    valueFile: string,
    state: Readonly<OAuthStateFile>,
  ): boolean => {
    try {
      deps.files.rewrite(valueFile, formatOAuthState(state));
      unsaved.delete(name);

      return true;
    } catch (error) {
      unsaved.set(name, { valueFile, state });

      log(
        `impd: broker: oauth secret ${name}: could not write its value file: ${getErrorMessage(error)}`,
      );

      return false;
    }
  };

  const loadState = (name: string, secret: Readonly<SecretRecord>): OAuthStateFile | null => {
    const kept = unsaved.get(name);

    if (kept?.valueFile === secret.valueFile) {
      return kept.state;
    }

    const text = deps.files.read(secret.valueFile);

    return text === null ? null : parseOAuthState(text);
  };

  const sendTokenRequest = async (
    config: Readonly<OAuthConfig>,
    refreshToken: string,
  ): Promise<Classified> => {
    const url = new URL(config.tokenUrl);

    const upstream = deps.resolveUpstream(url.host);

    const fields = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
    };

    const headers = new Headers({ accept: 'application/json' });

    let body: string;

    if (config.tokenFormat === 'json') {
      headers.set('content-type', 'application/json');

      body = JSON.stringify(fields);
    } else {
      headers.set('content-type', 'application/x-www-form-urlencoded');

      body = new URLSearchParams(fields).toString();
    }

    let response: Response;
    let text: string;

    try {
      response = await send(`${upstream.origin}${url.pathname}${url.search}`, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        ...(upstream.ca !== null && { tls: { ca: upstream.ca } }),
      });

      text = await response.text();
    } catch (error) {
      return {
        kind: 'transient',
        error:
          error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network error',
      };
    }

    return parseTokenAnswer(response.status, text);
  };

  const runRefresh = async (name: string, force: boolean): Promise<RefreshOutcome> => {
    const secret = await readSecret(deps.db, name);

    if (secret?.kind !== 'oauth' || secret.oauth === null) {
      unsaved.delete(name);
      backoff.delete(name);

      return { kind: 'gone' };
    }

    const state = loadState(name, secret);

    if (state === null) {
      log(`impd: broker: oauth secret ${name}: its value file is missing or unreadable`);

      return { kind: 'unreadable' };
    }

    if (unsaved.has(name) && !writeState(name, secret.valueFile, state)) {
      return { kind: 'transient', error: 'value file not writable' };
    }

    if (!force && state.status === 'needs_login') {
      return { kind: 'needs-login', error: state.error ?? 'needs login' };
    }

    const classified = await sendTokenRequest(secret.oauth, state.refreshToken);
    const current = await readSecret(deps.db, name);

    if (current?.valueFile !== secret.valueFile || current.generation !== secret.generation) {
      log(
        `impd: broker: oauth secret ${name} was replaced or deleted during a refresh; its result was dropped`,
      );

      return { kind: 'dropped' };
    }

    if (classified.kind === 'ok') {
      return applyTokens(name, secret, state, classified.tokens);
    }

    return applyFailure(name, secret, state, classified);
  };

  const applyTokens = (
    name: string,
    secret: Readonly<SecretRecord>,
    state: Readonly<OAuthStateFile>,
    tokens: Readonly<TokenResponse>,
  ): RefreshOutcome => {
    const at = now();
    const accessToken = tokens.accessToken ?? state.accessToken;

    if (accessToken === null) {
      // a rotated refresh token is the only live one: keep it
      const kept =
        tokens.refreshToken === null ? state : { ...state, refreshToken: tokens.refreshToken };

      return writeTransient(name, secret, kept, 'no access token in the response');
    }

    const refreshToken = tokens.refreshToken ?? state.refreshToken;

    // a response with only a rotated refresh token leaves the access token
    // and its expiry as they were: expires_in describes a new access token
    let expiresAt: number | null;

    if (tokens.accessToken === null) {
      expiresAt = state.expiresAt;
    } else if (tokens.expiresInMs === null) {
      expiresAt = readJwtExpiry(accessToken);
    } else {
      expiresAt = at + tokens.expiresInMs;
    }

    if (expiresAt !== null && !isValidTime(expiresAt)) {
      expiresAt = null;
    }

    const next: OAuthStateFile = {
      // oxlint-disable-next-line id-length -- `v` is the OAuth state file's version field
      v: 1,
      refreshToken,
      accessToken,
      idToken: tokens.idToken ?? state.idToken,
      expiresAt,
      refreshedAt: at,
      status: 'ready',
      error: null,
    };

    backoff.delete(name);

    writeState(name, secret.valueFile, next);

    const rotated = refreshToken !== state.refreshToken;

    log(
      `impd: broker: oauth secret ${name} refreshed; refresh token rotated: ${rotated ? 'yes' : 'no'}; expires ${expiresAt === null ? 'never known' : new Date(expiresAt).toISOString()}`,
    );

    return { kind: 'refreshed', rotated };
  };

  const writeTransient = (
    name: string,
    secret: Readonly<SecretRecord>,
    state: Readonly<OAuthStateFile>,
    error: string,
  ): RefreshOutcome => {
    const failures = (backoff.get(name)?.failures ?? 0) + 1;
    const delay = buildBackoffMs(failures, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });

    backoff.set(name, { failures, nextAt: now() + delay });

    writeState(name, secret.valueFile, { ...state, error });

    log(
      `impd: broker: oauth secret ${name} could not refresh: ${error}; trying again in ${String(Math.round(delay / 60_000))} min`,
    );

    return { kind: 'transient', error };
  };

  const applyFailure = (
    name: string,
    secret: Readonly<SecretRecord>,
    state: Readonly<OAuthStateFile>,
    failure: Exclude<Classified, { kind: 'ok' }>,
  ): RefreshOutcome => {
    if (failure.kind === 'transient') {
      return writeTransient(name, secret, state, failure.error);
    }

    backoff.delete(name);

    writeState(name, secret.valueFile, { ...state, status: 'needs_login', error: failure.error });

    if (state.status !== 'needs_login') {
      log(`impd: broker: oauth secret ${name} needs a new sign-in: ${failure.error}`);
    }

    return { kind: 'needs-login', error: failure.error };
  };

  const startRefresh = async (name: string, force: boolean): Promise<RefreshOutcome> => {
    if (lifecycle.stopping) {
      return { kind: 'transient', error: 'impd is stopping' };
    }

    const run = (): Promise<RefreshOutcome> =>
      inflight.run(name, () => withLock(name, () => runRefresh(name, force)));

    const outcome = await run();

    if (outcome.kind === 'skipped' || (force && outcome.kind === 'superseded')) {
      return run();
    }

    return outcome;
  };

  const runRejectedRefresh = async (
    name: string,
    refreshedAt: number | null,
  ): Promise<RefreshOutcome> => {
    const secret = await readSecret(deps.db, name);

    if (secret?.kind !== 'oauth' || secret.oauth === null) {
      return { kind: 'gone' };
    }

    const state = loadState(name, secret);

    if (state === null) {
      return { kind: 'unreadable' };
    }

    if (state.refreshedAt !== refreshedAt) {
      return state.status === 'ready' ? { kind: 'superseded' } : { kind: 'skipped' };
    }

    const at = now();
    const wait = backoff.get(name);

    if (
      state.status !== 'ready' ||
      (wait !== undefined && wait.nextAt > at) ||
      (state.refreshedAt !== null && at - state.refreshedAt < REJECTION_FLOOR_MS)
    ) {
      return { kind: 'skipped' };
    }

    log(`impd: broker: oauth secret ${name}: a granted host refused its access token; refreshing`);

    return runRefresh(name, false);
  };

  const refreshAfterRejection = async (
    name: string,
    refreshedAt: number | null,
  ): Promise<boolean> => {
    if (lifecycle.stopping) {
      return false;
    }

    try {
      const outcome = await inflight.run(name, () =>
        withLock(name, () => runRejectedRefresh(name, refreshedAt)),
      );

      return outcome.kind === 'refreshed' || outcome.kind === 'superseded';
    } catch (error) {
      log(`impd: broker: oauth secret ${name}: ${getErrorMessage(error)}`);

      return false;
    }
  };

  const writeUnsaved = async (name: string): Promise<void> => {
    if (!unsaved.has(name)) {
      return;
    }

    try {
      await withLock(name, async () => {
        const kept = unsaved.get(name);

        if (kept === undefined) {
          return;
        }

        const current = await readSecret(deps.db, name);

        if (current?.kind !== 'oauth' || current.valueFile !== kept.valueFile) {
          unsaved.delete(name);

          return;
        }

        writeState(name, kept.valueFile, kept.state);
      });
    } catch (error) {
      log(`impd: broker: oauth secret ${name}: ${getErrorMessage(error)}`);
    }
  };

  const runDueRefreshes = async (): Promise<void> => {
    try {
      const at = now();

      const listed = await listSecrets(deps.db);

      for (const entry of listed) {
        const secret = entry.secret;

        if (lifecycle.stopping) {
          break;
        }

        if (secret.kind !== 'oauth' || secret.oauth === null) {
          continue;
        }

        await writeUnsaved(secret.name);

        const wait = backoff.get(secret.name);

        if (wait !== undefined && wait.nextAt > at) {
          continue;
        }

        const state = loadState(secret.name, secret);

        if (state === null || !isDue(state, at)) {
          continue;
        }

        try {
          await startRefresh(secret.name, false);
        } catch (error) {
          log(`impd: broker: oauth secret ${secret.name}: ${getErrorMessage(error)}`);
        }
      }
    } catch (error) {
      log(`impd: broker: oauth refresh check failed: ${getErrorMessage(error)}`);
    }
  };

  return {
    refresh: startRefresh,
    refreshAfterRejection,
    withLock,
    tick: runDueRefreshes,
    start: () => {
      timer.ticker = startTicker({
        label: 'oauth-refresh',
        intervalMs: 60_000,
        firstDelayMs: 0,
        task: runDueRefreshes,
        log,
        timer: deps.timer,
      });
    },
    stop: async () => {
      lifecycle.stopping = true;

      await timer.ticker?.stop();
      await inflight.waitForAll();
      await Promise.allSettled([...unsaved.keys()].map((name) => writeUnsaved(name)));
    },
  };
}

function isValidTime(durationMs: number): boolean {
  return Number.isFinite(durationMs) && !Number.isNaN(new Date(durationMs).getTime());
}
