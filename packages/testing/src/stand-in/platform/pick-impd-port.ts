const FIRST_PORT = 10_100;
const PORT_SPAN = 9900;

// below the imps' port range, where the config refuses impd's own ports, and above 10080,
// which fetch refuses as a bad port
export function pickImpdPort(draw: number): number {
  return FIRST_PORT + Math.floor(draw * PORT_SPAN);
}
