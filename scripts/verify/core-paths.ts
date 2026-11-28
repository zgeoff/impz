// What every journey on `local` runs, so a change to any of it flags each feature that runs there.
// When you can't tell whether a journey reaches a path, add it here: a missed feature costs more
// than a journey.
export const corePaths = {
  // Package folders that every journey runs whole, each with the workspace packages it depends on.
  packages: [
    // the `local` target's app, which boots impd on stand-in VMs
    'packages/testing',

    // the oRPC contract that every action and every MCP tool calls impd through
    'packages/api',

    // the client that every action, and impd's MCP route, sends its calls with
    'packages/client',

    // the operations and reconcilers that run each create and destroy
    'packages/durable',

    // impd's side of the guest agent's protocol, which every start loads
    'packages/agent-protocol',

    // the local files tar that impd loads for an image build, which you can't trace to one journey
    'packages/local-tar',

    // the helpers that every package imports
    'packages/shared',
  ],

  // Globs that skip the dependency walk. They hold the part of impd that every journey runs, and
  // each feature names the other parts its journey reaches.
  globs: [
    // impd's manifest, whose exports the `local` app imports impd by, and its entry and config
    'packages/daemon/package.json',
    'packages/daemon/src/*.ts',

    // the layers that create, list, sleep and destroy an imp, with the start that wires them; the
    // parts that only a real VM runs sit here too, because the stand-in VMs run impd's VM layer
    'packages/daemon/src/{host-net,imp-ops,impd,imps,network,vm}/**',

    // the database, the audit log, the errors, the HTTP helpers and the event log that each
    // create writes
    'packages/daemon/src/platform/{audit,db,errors,http,principal,process,secrets,telemetry}/**',
    'packages/daemon/src/platform/events/event-bus.ts',

    // the root token that every action signs in with, and the access rules every call passes
    'packages/daemon/src/identity/*.ts',
    'packages/daemon/src/identity/auth/**',

    // the API app and its router, the imp routes that every journey calls, and the other routes,
    // which start-up loads and no journey can be traced away from
    'packages/daemon/src/surface/{build-api-listen-options,build-audit-routes,build-caller-imps,find-imp-refusal,get-raw-socket,read-buffered-amount,read-error-code,read-host-info,require-named-imp,surface-config,to-api-image,to-orpc-error,with-retry-after}.ts',
    'packages/daemon/src/surface/create-{app,backup-routes,checkpoint-routes,dashboard-routes,exec-routes,exec-sockets,file-routes,grant-routes,identity-routes,imp-routes,implementer,lease-routes,move-routes,network-routes,router,secret-routes,service-routes,session-routes,socket-registry,system-routes,token-routes,tunnel-socket-route}.ts',
    'packages/daemon/src/surface/{auth,dashboard,exec,images,moves,ssh}/**',
  ],
} as const;
