import type { MessageDirection } from '../../packages/api/src/protocols/build-protocol-schema';
import type { Schema } from './read-schema';

export interface Comparison {
  readonly direction: MessageDirection;

  // the roots each side's `$ref` resolves in
  readonly narrowRoot: Schema;
  readonly wideRoot: Schema;

  // the `$ref` pairs already under comparison, which a recursive schema meets again
  readonly seen: ReadonlySet<string>;

  // a reader that names its fields, so an optional property must stay too
  readonly hasStableFields: boolean;

  // the discriminator of the unions at a path, found from both sides' options
  readonly unionTags?: { readonly path: string; readonly keys: readonly string[] };
}
