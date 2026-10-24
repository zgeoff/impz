import { createHash } from 'node:crypto';

export function buildReceivedDigest(
  rootfsContentSha256: string,
  configContentSha256: string,
): string {
  const hash = createHash('sha256').update(
    `rootfs ${rootfsContentSha256}\nconfig ${configContentSha256}\n`,
  );

  return `sha256:${hash.digest('hex')}`;
}
