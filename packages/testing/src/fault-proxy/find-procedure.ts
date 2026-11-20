const RPC_PREFIX = '/rpc/';

// the procedure that an oRPC call's path names, such as `imps/sleep`; null for any other path
export function findProcedure(pathname: string): string | null {
  return pathname.startsWith(RPC_PREFIX) ? pathname.slice(RPC_PREFIX.length) : null;
}
