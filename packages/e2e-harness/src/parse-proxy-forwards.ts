export interface ProxyForwards {
  readonly localPort: string | undefined;

  readonly guestPort: string | undefined;

  readonly socketPath: string | undefined;
}

export function parseProxyForwards(stdout: string): ProxyForwards {
  return {
    localPort: /forwarding localhost:(?<port>\d+) ->/v.exec(stdout)?.groups?.['port'],
    guestPort: /forwarding (?!localhost:)[^:\s]+:(?<port>\d+) ->/v.exec(stdout)?.groups?.['port'],
    socketPath: /forwarding [^:\s]+:(?<path>\/run\/imp\/forward\/\S+) ->/v.exec(stdout)?.groups?.[
      'path'
    ],
  };
}

export function findSocketListenAgain(stderr: string): string | undefined {
  return /forwarding [^:\s]+:(?<path>\/run\/imp\/forward\/\S+) -> \S+ again/v.exec(stderr)
    ?.groups?.['path'];
}
