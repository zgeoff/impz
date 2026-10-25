import { ImpdError } from '../../platform/errors/impd-error';

type MoveRequestCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'GONE'
  | 'PAYLOAD_TOO_LARGE';

// oRPC has no common code for HTTP 410, so a spent window carries its status itself.
const GONE_STATUS = 410;

export class MoveRequestError extends ImpdError<MoveRequestCode> {
  override name = 'MoveRequestError';

  constructor(code: MoveRequestCode, message: string) {
    super(code, { message, ...(code === 'GONE' && { status: GONE_STATUS }) });
  }
}
