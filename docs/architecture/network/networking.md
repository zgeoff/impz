# Networking

Every imp gets its own tap device and its own point-to-point subnet, routed through the host
container, and an IPv6 address when the host has IPv6 set up as [IPv6](#ipv6) describes. No two imps
share a layer-2 network, and an imp reaches another only when a private network lets it
([egress](./egress.md#networks)). Everything here lives in the imp-host container's own network
namespace, so none of it touches the host's network. [Egress](./egress.md) covers what an imp may
reach, [ingress](./ingress.md) how a request reaches an imp, and [the broker](./broker.md) the port
it serves in the container. A guest reaches only two ports in the container: the broker's and the
resolver's.

## Addressing

impd carves each imp's subnet from one range, by slot: slot n owns one small block, with the host's
end and the guest's end of the link in it. The tap is named by the slot, the guest's MAC is derived
from the guest's address, and a new tap's MAC from the host's. An imp keeps its slot for its whole
life, so its tap name and its address survive a sleep and a restore. A container restart removes
every tap, and a warm move ([moves](../storage/moves.md#warm-moves)) puts the imp on another host.
Either way impd makes the tap again with the same MAC, so the woken guest's neighbour entry for its
gateway stays valid. A tap that exists keeps its MAC, which its guest knows.

impd passes the guest its address, gateway and DNS servers on the kernel command line, and the agent
brings the network up from them. When an imp's policy routes its DNS to impd, impd redirects its
queries whatever server the guest asks ([egress](./egress.md#the-resolver)).

## The base firewall

The host container's setup script writes the rules every policy rests on, before impd starts:

- NAT for the imp range out of the container's default route.
- No traffic from one tap to another, except what impd's own table marked as two members of one
  private network.
- Nothing over IPv4 from a tap to the container itself, except replies to connections the container
  opened, the broker's port and the resolver's port. The broker and the resolver listen on every
  address, so the rules drop packets to their ports from anything but a tap. They drop them before
  the input rules, because tailscaled would otherwise accept tailnet packets first.
- A strict reverse-path check on the taps only, so a guest cannot send with another imp's address.
  The broker identifies an imp by its address, and this check is what makes that safe. A sysctl
  would apply the same check to the uplink and the tailnet too, and break an exit node or subnet
  routes.
- Tailscale's address ranges accepted only from the tailnet interface, so a tailnet identity always
  belongs to the real peer ([auth](../control/auth.md#tailnet-identity)).
- The TCP MSS of guest connections clamped to the uplink's real MTU. Behind a smaller uplink, the
  ICMP that would tell a guest to send smaller packets never reaches it, and large TLS records
  stall.

impd's own nftables table sits on top, written whole in one transaction. It marks private-network
traffic for the tap-to-tap rule above, and otherwise can only refuse a packet that these rules let
through ([egress](./egress.md#the-firewall)).

## IPv6

impd decides at start whether imps get IPv6, and fails closed: when the container's IPv6 rules and
settings are not all in place, or the NAT66 table cannot be written, imps get none, and IPv4 and its
firewall go on as before. With IPv6, each imp gets a /128 in one /64, either a unique local prefix
impd keeps behind NAT66, or a /64 the network routes to the container. The interface ID is the imp's
IPv4 address, so the address lasts as long as the slot and the prefix. Every tap answers as the
link-local gateway, impd routes each imp's /128 to its tap, and the agent turns off router
advertisements and redirects on the guest's side.

A guest on a tap could send router advertisements or redirects, and the container, which forwards,
could take one as its route out. So nothing a guest sends changes the container's routes: the taps
and the defaults ignore both, and the container's IPv6 input from a tap allows only neighbour
discovery. impd's own table holds the same input rule under every policy, so the rule still applies
where the setup script's rules are missing.

A snapshot holds the prefix it was made under, so when the host's prefix changes, or IPv6 goes off,
an imp boots cold on its next wake. An imp that booted with no IPv6 wakes as it was, and gets IPv6
at its next cold boot. Private networks are IPv4 only.
