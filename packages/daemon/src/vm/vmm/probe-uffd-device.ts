import { accessSync, constants } from 'node:fs';

// A jailed Firecracker runs unprivileged, so it gets its userfaultfd from this
// device, which the jailer copies into each jail from the host's.
export function probeUffdDevice(path = '/dev/userfaultfd'): boolean {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);

    return true;
  } catch {
    return false;
  }
}
