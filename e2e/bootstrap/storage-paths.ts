// Storage is a loop file or a loop device in the container, never a disk: the empty and ext4 files
// back the --data-device leg's loop devices.
export const STORAGE_PATHS = {
  loopFile: '/var/imp.xfs',
  diskEmpty: '/var/disk-empty.img',
  diskExt4: '/var/disk-ext4.img',
} as const;
