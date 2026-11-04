export interface TemplateFile {
  readonly name: string;
  readonly ageMs: number;
  readonly isOwnerGone: boolean;
}

// a build takes well under a second, so a lock this old belongs to a run that
// died, even one in another PID namespace or one that never wrote its owner
const LOCK_EXPIRY_MS = 30_000;

// a unit run takes minutes, so a run that still copies a template of older
// migrations has used it within the hour
const UNUSED_EXPIRY_MS = 3_600_000;

export function isStaleTemplateFile(file: TemplateFile, hash: string): boolean {
  if (file.name.endsWith('.lock')) {
    return file.isOwnerGone || file.ageMs > LOCK_EXPIRY_MS;
  }

  if (/^pid\d+-ns\d+-/u.test(file.name)) {
    return file.isOwnerGone || file.ageMs > UNUSED_EXPIRY_MS;
  }

  return !file.name.endsWith(`-${hash}.sqlite`) && file.ageMs > UNUSED_EXPIRY_MS;
}
