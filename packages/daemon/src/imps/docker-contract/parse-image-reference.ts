export interface ImageReference {
  readonly registry: string;
  readonly path: string;
  readonly tag: string | null;
  readonly digest: string | null;
}

// Docker's own reading of a reference: the first segment is a registry only when another
// follows and it holds a dot or a port, or is localhost; Docker Hub's official images sit
// under library/.
export function parseImageReference(reference: string): ImageReference {
  const [withoutDigest = '', digest] = reference.split('@');
  const lastSlash = withoutDigest.lastIndexOf('/');
  const tagColon = withoutDigest.indexOf(':', lastSlash + 1);
  const name = tagColon === -1 ? withoutDigest : withoutDigest.slice(0, tagColon);
  const [first = '', ...rest] = name.split('/');

  const isRegistry =
    rest.length > 0 &&
    (first.includes('.') || first.includes(':') || first.toLowerCase() === 'localhost');

  const registry = isRegistry ? first : 'docker.io';
  const path = isRegistry ? rest.join('/') : name;

  return {
    registry: registry === 'index.docker.io' ? 'docker.io' : registry,
    path: registry === 'docker.io' && !path.includes('/') ? `library/${path}` : path,
    tag: tagColon === -1 ? null : withoutDigest.slice(tagColon + 1),
    digest: digest ?? null,
  };
}

export function formatFamiliarRepository(reference: Readonly<ImageReference>): string {
  if (reference.registry !== 'docker.io') {
    return `${reference.registry}/${reference.path}`;
  }

  return reference.path.startsWith('library/') && reference.path.split('/').length === 2
    ? reference.path.slice('library/'.length)
    : reference.path;
}
