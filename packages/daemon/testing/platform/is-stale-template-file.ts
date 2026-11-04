export interface TemplateFile {
  readonly name: string;
  readonly ageMs: number;
  readonly isOwnerGone: boolean;
}

// a build takes well under a second and a unit run takes minutes, so no build
// still writes a file this old, and a run that still copies a template this
// old builds it again when a sweep removed it
const STALE_AFTER_MS = 3_600_000;

export function isStaleTemplateFile(file: TemplateFile, hash: string): boolean {
  if (/^pid\d+-ns\d+-/u.test(file.name)) {
    return file.isOwnerGone || file.ageMs > STALE_AFTER_MS;
  }

  return !file.name.endsWith(`-${hash}.sqlite`) && file.ageMs > STALE_AFTER_MS;
}
