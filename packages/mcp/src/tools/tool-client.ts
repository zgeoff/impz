import type { ImpClient } from '@impz/client';

export interface ToolClient {
  readonly imps: Pick<ImpClient['imps'], 'list' | 'create' | 'destroy' | 'sleep' | 'url' | 'fork'>;
  readonly images: Pick<ImpClient['images'], 'list'>;
  readonly checkpoints: Pick<ImpClient['checkpoints'], 'create' | 'list' | 'restore' | 'delete'>;
  readonly events: Pick<ImpClient['events'], 'list'>;
  readonly openExec: ImpClient['openExec'];
}
