export function mergeSignals(
  request: AbortSignal | undefined,
  ends: AbortSignal | null,
): AbortSignal | undefined {
  if (ends === null) {
    return request;
  }

  return request === undefined ? ends : AbortSignal.any([request, ends]);
}
