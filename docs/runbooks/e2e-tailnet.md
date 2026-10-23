# The e2e tailnet

The e2e harness runs the tailscale, egress and moves-tailnet suites on a tailnet of the run's own: a
Headscale control server in a container, which holds no production service and needs no secret. Each
impd node on it joins as `tag:imp-e2e`, under a policy that copies the production tailnet's grants
for that tag, so the suites test the same contract. The test-side member joins as a user, with no
tag. The tailnet-names suite and a dev instance started with `IMP_TAILSCALE_OP=1` join Tailscale
itself as `tag:imp-e2e`, which impz owns with its OAuth client and the 1Password vault `imp-e2e`.
[Development](./development.md#end-to-end-tests) covers how to run the suites, and
[configuration](../guides/configuration.md#dev-instance) covers the order in which `dev.sh` looks
for a key.

## The run's Headscale

When a run holds a Headscale suite, the harness sets the tailnet up before the dev instance starts,
and takes it down after the last suite:

1. The harness creates the Docker network `<IMP_DEV_NAME>-ts` if it is missing, and starts Headscale
   on it under the alias `headscale`. Headscale reads its config and policy from
   [`e2e/fixtures/headscale/`](../../e2e/fixtures/headscale/) and keeps its state on a tmpfs, so
   each run starts from an empty tailnet.
2. The harness mints a reusable, ephemeral pre-auth key that carries `tag:imp-e2e`. One key joins
   the dev instance at each start and reboot, and the moves suites' second host. Each impd node
   keeps its state in memory, so a node from an earlier run never comes back.
3. The harness starts the test-side member, `<IMP_DEV_NAME>-ts-member`, a Tailscale container that
   joins with a key of the user `e2e-member`. The suites read its `tailscale status` and fetch over
   the tailnet through it, since this machine's own tailscaled stays on the tailnet it already has.
4. The dev instance starts on `<IMP_DEV_NAME>-ts` with the key, `IMP_TAILSCALE_LOGIN_SERVER` set to
   `http://headscale:8080` and `IMP_TAILSCALE_TAGS=tag:imp-e2e`.
5. After the last suite, the harness removes the member and Headscale, whether the run passed or
   not. The network stays while the dev instance is on it, and the next run starts its Headscale on
   that network. A run that finds a member or a Headscale left over from a killed run removes them
   first.

Headscale's relay serves plain HTTP, and tailscaled reaches a relay only over TLS. Two nodes
therefore reach each other only on a Docker network they share. The moves-tailnet suite connects
Headscale to its move network, and the dev instance and its second host meet there.

The policy copies the production tailnet's grants for the tag. Members, such as the member
container, reach every port of a `tag:imp-e2e` node. One `tag:imp-e2e` node reaches another only on
port 7070, so the moves suites' two impds reach each other's API and no other port.

## What the production tailnet holds

The production tailnet has one policy file, and the infrastructure repo that holds it applies it
whole. This section states the part of that file impz relies on, so a change there that breaks
impz's tests breaks this contract.

| Where                                              | Holds                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| the tailnet policy                                 | the tag `tag:imp-e2e`, owned by admins and itself, and its one grant |
| the OAuth client `imp-e2e`                         | scope Auth Keys (write) only, tag `tag:imp-e2e` only                 |
| vault `imp-e2e`, item `imp-e2e-tailscale-oauth`    | the client's `client-id` and `client-secret`                         |
| vault `imp-e2e`, item `imp-e2e-tailscale-services` | the Services OAuth client of the tailnet-names suite                 |

The policy holds these two entries for the tag, and no grant that takes `tag:imp-e2e` to `tag:imp`:

```json
{
  "tagOwners": { "tag:imp-e2e": ["autogroup:admin", "tag:imp-e2e"] },
  "grants": [{ "src": ["tag:imp-e2e"], "dst": ["tag:imp-e2e"], "ip": ["tcp:7070"] }]
}
```

The tag owns itself because an OAuth client mints keys only for tags its own tags own. Members reach
every tagged node through the policy's members grant, so you reach a dev instance on `tag:imp-e2e`
as you would any host.

## How the scripts use the client

The dev script and the harness's tailnet-names run read the client secret with `op read`, add
`?ephemeral=true&preauthorized=true`, and pass it to `tailscale up` as the auth key with
`--advertise-tags=tag:imp-e2e`. Each node is ephemeral, so Tailscale removes it soon after it goes
offline, and a dev instance that restarts later joins again with the same secret. No script defaults
to an item outside the `imp-e2e` vault. The `imp` op-mint profile's token reads that vault and
nothing else.

## Replace the client

1. In the Tailscale admin console's trust credentials page, add an OAuth credential: description
   `imp-e2e`, scope Auth Keys (write) only, tag `tag:imp-e2e` only.
2. Store its ID and secret in the vault `imp-e2e`, item `imp-e2e-tailscale-oauth`, fields
   `client-id` and `client-secret`. Never paste the secret into a command line.
3. Revoke the old client on the same page.

The secret does not expire. Replace it when it may have leaked.

## Check the isolation

From a `tag:imp-e2e` node, a request to the API of a live impd on `tag:imp` must time out, because
the policy gives the node no route to it. Use a TCP request such as
`curl --max-time 5 http://<impd_tailnet_ip>:7070/`. A plain `tailscale ping` does not test this,
because its default ping tests the connection between the two devices, not the policy.
