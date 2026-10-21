import type { MessageDirection } from '../../../packages/api/src/protocols/build-protocol-schema';
import type { Schema } from './schema';

export interface Comparison {
  readonly direction: MessageDirection;
  readonly narrowRoot: Schema;
  readonly wideRoot: Schema;
  readonly seen: ReadonlySet<string>;
  readonly hasStableFields: boolean;
  readonly unionTags?: { readonly path: string; readonly keys: readonly string[] };
}
