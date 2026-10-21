import type { ImpChangeReason, ImpEventDetail } from '@impz/api';
import type { EventBus } from '../events/event-bus';
import type { CheckpointRecord } from './checkpoints';
import type { ImpRecord } from './imps';

export type ImpWrite =
  | { readonly kind: 'added'; readonly imp: ImpRecord }
  | {
      readonly kind: 'changed';
      readonly imp: ImpRecord;
      readonly reason: ImpChangeReason;
      readonly detail?: ImpEventDetail;
    }
  | { readonly kind: 'removed'; readonly imp: ImpRecord }
  | { readonly kind: 'checkpointAdded'; readonly checkpoint: CheckpointRecord }
  | { readonly kind: 'checkpointRemoved'; readonly checkpoint: CheckpointRecord };

export type ImpWriteFeed = EventBus<ImpWrite>;
