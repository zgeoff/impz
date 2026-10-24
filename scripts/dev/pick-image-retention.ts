import { buildDevImageTag } from '../lib/build-dev-image-tag.ts';

export interface ImageLabels {
  readonly worktree: string;
  readonly machine: string;
}

export interface ImageObservation {
  readonly ref: string;
  readonly labels: ImageLabels | null;
  readonly isCheckoutLive: boolean;
  readonly isInUse: boolean;
}

type ImageRetention =
  | { readonly kind: 'skip' }
  | { readonly kind: 'keep'; readonly reason: string }
  | { readonly kind: 'remove' };

export function pickImageRetention(image: ImageObservation, machineID: string): ImageRetention {
  if (image.labels === null) {
    return { kind: 'keep', reason: 'docker image inspect failed' };
  }

  // An empty label names no checkout, so it cannot be gone.
  if (image.labels.worktree === '' || image.isCheckoutLive || image.labels.machine !== machineID) {
    return { kind: 'skip' };
  }

  if (image.ref !== buildDevImageTag(image.labels.worktree)) {
    return { kind: 'keep', reason: `not the tag of ${image.labels.worktree}` };
  }

  if (image.isInUse) {
    return { kind: 'keep', reason: 'a container uses it' };
  }

  return { kind: 'remove' };
}
