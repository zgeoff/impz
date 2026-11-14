// The host ports a dev instance at `offset` publishes, as scripts/lib/build-dev-layout.ts lays them
// out: the API, the public MCP route, the proxy, ssh and the 64 imp ports.
export function collectDevPorts(offset: number): number[] {
  const impPorts = Array.from({ length: 64 }, (_, index) => 20_000 + offset + index);

  return [7070 + offset, 7071 + offset, 7080 + offset, 2222 + offset, ...impPorts];
}
