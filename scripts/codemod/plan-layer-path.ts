// the daemon's layers and the move table that nests its folders under them
export const LAYER_TABLE = {
  daemonSrc: 'packages/daemon/src',

  // from the bottom up: a layer imports only the layers below it
  layers: ['platform', 'host-net', 'vm', 'imps', 'network', 'identity', 'imp-ops', 'surface'],

  // each old folder or file stem under src, and the path it moves to. A file stem moves the
  // file's test too, and the longest match wins, so `ssh/ssh-gateway` leaves the `ssh` folder.
  moves: {
    // platform: the helpers every layer uses
    audit: 'platform/audit',
    db: 'platform/db',
    events: 'platform/events',
    process: 'platform/process',
    telemetry: 'platform/telemetry',
    'merge-signals': 'platform/process/merge-signals',
    'get-error-message': 'platform/process/get-error-message',

    // host-net: the host's addressing, TAP devices and routes
    net: 'host-net/net',

    // vm: one microVM and its guest agent
    'agent-client': 'vm/agent-client',
    'checkpoints/consistent-disk': 'vm/checkpoints/consistent-disk',
    governor: 'vm/governor',
    memory: 'vm/memory',
    sleep: 'vm/sleep',
    storage: 'vm/storage',
    templates: 'vm/templates',
    vmm: 'vm/vmm',
    'watchdog/agent-watchdog': 'vm/watchdog/agent-watchdog',

    // imps: an imp and what runs inside it
    'docker-proxy': 'imps/docker-proxy',
    exec: 'imps/exec',
    files: 'imps/files',
    images: 'imps/images',
    imps: 'imps/imps',
    reverse: 'imps/reverse',
    services: 'imps/services',
    'session-logs': 'imps/session-logs',
    sessions: 'imps/sessions',
    ssh: 'imps/ssh',
    tunnel: 'imps/tunnel',

    // network: the imps' networks, egress, ingress and the secret broker
    broker: 'network/broker',
    egress: 'network/egress',
    https: 'network/https',
    networks: 'network/networks',
    proxy: 'network/proxy',
    'tailnet-names': 'network/tailnet-names',

    // identity: who calls impd
    auth: 'identity/auth',
    oauth: 'identity/oauth',
    token: 'identity/token',

    // imp-ops: the operations that drive whole imps
    backup: 'imp-ops/backup',
    checkpoints: 'imp-ops/checkpoints',
    idle: 'imp-ops/idle',
    moves: 'imp-ops/moves',
    watchdog: 'imp-ops/watchdog',

    // surface: the API, the gateways and the routes that callers reach
    'api-errors': 'surface/api-errors',
    'api-listen-options': 'surface/api-listen-options',
    'auth/session-routes': 'surface/auth/session-routes',
    'build-audit-routes': 'surface/build-audit-routes',
    'create-app': 'surface/create-app',
    'create-dashboard-routes': 'surface/create-dashboard-routes',
    'create-grant-routes': 'surface/create-grant-routes',
    'create-image-routes': 'surface/create-image-routes',
    'create-implementer': 'surface/create-implementer',
    'create-network-routes': 'surface/create-network-routes',
    'create-oauth-routes': 'surface/create-oauth-routes',
    'create-router': 'surface/create-router',
    'create-secret-routes': 'surface/create-secret-routes',
    'create-system-routes': 'surface/create-system-routes',
    'create-token-routes': 'surface/create-token-routes',
    dashboard: 'surface/dashboard',
    'exec/exec-grant': 'surface/exec/exec-grant',
    'exec/exec-tickets': 'surface/exec/exec-tickets',
    'images/build-context-route': 'surface/images/build-context-route',
    'is-public-cross-origin': 'surface/is-public-cross-origin',
    mcp: 'surface/mcp',
    'oauth/public-listener': 'surface/oauth/public-listener',
    'read-buffered-amount': 'surface/read-buffered-amount',
    'require-named-imp': 'surface/require-named-imp',
    'ssh/host-key': 'surface/ssh/host-key',
    'ssh/login-keys': 'surface/ssh/login-keys',
    'ssh/ssh-gateway': 'surface/ssh/ssh-gateway',
    'ssh/start-ssh': 'surface/ssh/start-ssh',
    'to-api-image': 'surface/to-api-image',
    'with-retry-after': 'surface/with-retry-after',
  } as Readonly<Record<string, string>>,

  // the composition root's files, which import every layer and stay at the top of src
  rootStems: [
    'config',
    'create-impd',
    'create-impd-app',
    'create-impd-firewall',
    'create-impd-imps',
    'create-impd-moves',
    'create-impd-services',
    'create-impd-storage',
    'create-tailnet-access',
    'impd-deps',
    'impd-startup-steps',
    'index',
    'load-impd-access',
    'main',
    'render-network-env',
    'shell-script',
    'start-impd-listeners',
    'start-impd-tickers',
    'stop-impd',
  ],
} as const;

// a moved path's first two segments mark a path as placed: `imps` is a layer and an old folder
// both, so `imps/imp-service.ts` moves and `imps/imps/imp-service.ts` stays
const PLACED_PREFIXES = new Set(
  Object.values(LAYER_TABLE.moves).map((target) => target.split('/').slice(0, 2).join('/')),
);

const MOVE_KEYS = Object.keys(LAYER_TABLE.moves).toSorted(
  (left, right) => right.length - left.length,
);

// the path under src that `path` moves to, or `path` itself when it is already placed or stays
export function planLayerPath(path: string): string {
  if (PLACED_PREFIXES.has(path.split('/').slice(0, 2).join('/'))) {
    return path;
  }

  const key = MOVE_KEYS.find(
    (candidate) =>
      path === candidate || path.startsWith(`${candidate}/`) || path.startsWith(`${candidate}.`),
  );

  return key === undefined ? path : `${LAYER_TABLE.moves[key]}${path.slice(key.length)}`;
}
