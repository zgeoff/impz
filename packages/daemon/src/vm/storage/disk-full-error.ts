import { ImpdError, isImpdError } from '../../platform/errors/impd-error';

export class DiskFullError extends ImpdError<'DISK_FULL'> {
  override name = 'DiskFullError';

  constructor(availableBytes: number, reserveBytes: number, requestedBytes: number) {
    super('DISK_FULL', {
      status: 507,
      message: `not enough free disk: ${formatGib(availableBytes)} free, ${formatGib(requestedBytes)} wanted, and ${formatGib(reserveBytes)} is held in reserve (IMP_DISK_RESERVE_GIB)`,
      data: { availableBytes, reserveBytes, requestedBytes },
    });
  }
}

export function isDiskFullError(error: unknown): error is ImpdError<'DISK_FULL'> {
  return isImpdError(error, 'DISK_FULL');
}

const GIB = 1024 ** 3;

function formatGib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}
