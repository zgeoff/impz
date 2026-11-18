import type { ImpClient } from '@impz/client';
import { createImpClient } from '@impz/client';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { ReactNode } from 'react';
import { createContext, use } from 'react';

export interface Impd {
  readonly client: ImpClient;
  readonly query: ReturnType<typeof buildQueryUtils>;
}

export function buildBrowserImpd(origin: string): Impd {
  const client = createImpClient({ url: origin });

  return { client, query: buildQueryUtils(client) };
}

// the SDK's exec helpers are not oRPC procedures, so only the contract's
// namespaces go in
function buildQueryUtils(client: ImpClient) {
  return createTanstackQueryUtils({
    imps: client.imps,
    checkpoints: client.checkpoints,
    images: client.images,
    exec: client.exec,
    sessions: client.sessions,
    system: client.system,
    tokens: client.tokens,
  });
}

const ImpdContext = createContext<Impd | null>(null);

interface ImpdProviderProps {
  readonly impd: Impd;
  readonly children: ReactNode;
}

export function ImpdProvider(props: ImpdProviderProps) {
  return <ImpdContext value={props.impd}>{props.children}</ImpdContext>;
}

export function useImpd(): Impd {
  const impd = use(ImpdContext);

  if (impd === null) {
    throw new Error('useImpd needs an ImpdProvider');
  }

  return impd;
}
