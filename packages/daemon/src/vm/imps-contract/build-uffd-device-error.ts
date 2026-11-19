import { ImpdError } from '../../platform/errors/impd-error';

export function buildUffdDeviceError(): ImpdError<'PRECONDITION_FAILED'> {
  return new ImpdError('PRECONDITION_FAILED', {
    message:
      'IMP_HUGE_PAGES=2M needs /dev/userfaultfd in the host container, and it has none: the host needs Linux 6.1 or later, and the container needs the device passed in',
  });
}
