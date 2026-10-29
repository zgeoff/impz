// 1005, 1006 and 1015 describe a close; they cannot be sent in one
export function toSendableCloseCode(code: number): number {
  return code === 1000 ||
    (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
    ? code
    : 1000;
}
