// The public listeners bind every address in the host container, so a port
// any other listener holds would make one of them fail at start.
export function checkPublicPorts(
  ports: Readonly<{ httpsPort: number; httpPort: number }>,
  others: readonly (readonly [string, number])[],
  slotPorts: readonly [number, number],
): void {
  const [first, last] = slotPorts;

  const publics = [
    ['IMP_PUBLIC_HTTPS_PORT', ports.httpsPort],
    ['IMP_PUBLIC_HTTP_PORT', ports.httpPort],
  ] as const;

  if (ports.httpsPort === ports.httpPort) {
    throw new Error('IMP_PUBLIC_HTTPS_PORT and IMP_PUBLIC_HTTP_PORT must differ');
  }

  for (const [name, port] of publics) {
    const clash = others.find(([, other]) => other === port);

    if (clash !== undefined) {
      throw new Error(`${name} ${String(port)} is also ${clash[0]}; give it a port of its own`);
    }

    if (port >= first && port <= last) {
      throw new Error(
        `${name} ${String(port)} is one of the imps' ports, ${String(first)} to ${String(last)}`,
      );
    }
  }
}
