# Imp identity

The credential broker adds a secret to an imp's requests, so a service sees a valid credential but
cannot tell which imp sent the request. A secret can ask the broker to name the imp: impd then
removes any `Imp-Identity` header the guest sent and adds its own, a short-lived token that impd
signs. A service that keeps state for each imp verifies the token and keys that state on the imp it
names. The feature is off until the operator sets an issuer. [The broker](./broker.md) describes the
request path this extends, and the [operator's guide](../../guides/imp-identity.md) covers the
commands.

## What the token proves

The token proves one fact: a request with this token left the broker's TLS terminator of the impd
named in `iss`, for the imp in `sub`, bound for the host in `aud`, within the acceptance window `W`.
`W` is the token life `L` plus the clock leeway `G`
([the guide](../../guides/imp-identity.md#what-the-service-checks) gives the values). That proof
rests on these assumptions:

- The broker names the imp from the connection's two ends, and the strict reverse-path check on the
  taps keeps a guest from sending with another imp's address
  ([the base firewall](./networking.md#the-base-firewall)).
- The guest cannot read impd's data directory, which holds the signing key.
- The host and impd are honest. A caller with root on the host signs any identity.
- impd makes each imp's ID at create, and the create call takes none. A move and a backup restore
  bring an ID from another host or from a backup, so every caller that may send a move to this impd,
  or restore a backup onto it, chooses the ID an imp arrives under.
- An ID is unique on one impd only, so the pair of issuer and ID names an imp
  ([identity across hosts](#identity-across-hosts)). No two running impds share an issuer.
- The service verifies the issuer, the signature, the audience and the times on every request.
- The service's clock and impd's clock differ by less than `G`.

The token says nothing about which process in the imp sent the request. Every process in an imp
shares the imp's identity.

A plain header carrying the imp's ID would fail open: any other holder of the service's credential
could name any imp, and an impd from before this feature would drop the setting and pass the guest's
own header upstream. A signed token fails closed in both cases, because a forged or stolen
credential carries no valid signature. The cost is a key that impd keeps, the public half of which
each service pins, and a verification step in each service.

## The token

The token is a JWT in compact form, signed with ES256, in one `Imp-Identity` header.

| Field      | Holds                                                        |
| ---------- | ------------------------------------------------------------ |
| `kid`      | the RFC 7638 thumbprint of impd's public key (header)        |
| `iss`      | this impd's issuer, the `IMP_IDENTITY_ISSUER` setting        |
| `sub`      | the imp's ID, unique on this impd only                       |
| `aud`      | the rule's host, as the guest names it, never the upstream   |
| `iat`      | the time of the send, in seconds                             |
| `exp`      | `iat` plus `L`                                               |
| `jti`      | 128 random bits, for a service that refuses a repeated token |
| `imp_name` | the imp's name, for logs                                     |

The broker signs a token for each send, so the resend of an OAuth secret after a 401 carries a new
one, and a request that the grant's filter refuses mints none. The token never holds a secret's name
or value, a grant filter, the imp's address or slot, or anything the guest supplied. An imp's row
has no owner and no fork parent, so the token has neither.

The issuer is 1 to 128 letters, digits, `.`, `_` and `-`. It has no default, because a fixed default
gives every host the same issuer, and the container's hostname changes with each container. An impd
without the setting reports `secretIdentity` as false in `system.info().features`, refuses to store
a rule with `identity`, and adds no token for a rule that already has it. The service then refuses
the request, which carries no token. With the setting, `system.info().identity.issuer` gives the
value to a session host that records which issuer made an imp.

The service accepts a token for `W` after its `iat` at most. It refuses a token when `exp - iat` is
more than `L`, when its clock is more than `G` past `exp`, or when `iat` is more than `G` ahead of
its clock. The verifier in `@impz/client/identity` holds these rules, with the key rules below.

## Identity across the lifecycle

| Event                  | The ID                                                |
| ---------------------- | ----------------------------------------------------- |
| Sleep and wake         | stays                                                 |
| Checkpoint restore     | stays, while the disk goes back                       |
| Fork                   | the fork gets its own ID and its own name             |
| Move to another host   | stays; the new host signs with its own key and issuer |
| Backup restore         | stays when no other imp on that host holds the ID     |
| Destroy, then a create | the name can return under another ID                  |

impd has no rename, so a name lasts as long as its imp. A name returns after a destroy, so a service
keys on the pair of issuer and ID and never on `imp_name`. A fork's disk and memory hold whatever
IDs the source guest held, such as a task ID, and the fork presents them under its own identity. A
service that binds state to an imp therefore refuses a fork until the owner binds that state again.

## Identity across hosts

A restore checks the ID against the imps of its own host and no other. A backup of an imp that still
runs on host A, restored on host B, gives a second imp with the same ID. Its grants return when host
B has a secret of the same name. So the ID alone names two imps, and the pair of issuer and ID names
one:

- Each impd signs with its own issuer. The restored copy's tokens carry host B's issuer.
- The service holds one key document for each host, and looks a token's key up in the document of
  the token's own issuer only. Host B's key never verifies a token that names host A. A service with
  two documents for one issuer refuses to start.
- The service compares the issuer and the ID with what the session host recorded for the session.
  The session host reads the issuer from `system.info().identity.issuer` of the impd it made the imp
  on. A session of host A's imp refuses the copy on host B with `other-host`, and refuses with
  `imp-issuer-unknown` until the session host gives the issuer.

A move keeps the ID and changes the issuer, so the service refuses the moved imp until the session
host records the new issuer. A host that replaces a dead one takes the dead host's issuer, so a
whole-host restore keeps each identity. The operator makes sure that the old host never runs again
under that issuer. A fresh ID for a restore on another host would cost more, because impd cannot
tell whether another host still holds an ID, and a caller such as a session host compares the ID it
recorded with the ID of the imp it finds.

## The key

impd makes one P-256 key pair at its first start, in `<data>/broker/identity/key.pem`, mode 0600 in
a 0700 directory, beside the broker CA. The private key leaves impd in no API answer and in no
backup, and the guest cannot read it. `impz identity jwks` and the `identity.jwks` procedure print
the public keys as a JWKS document with two more members, which RFC 7517 allows: `issuer`, and
`retire`. The operator copies that document into each service's configuration. No HTTP route serves
keys without a token, because a cached fetch would trust an old key for the life of the cache, where
a pinned document with a `retire` entry needs none.

## Replacing the key

impd signs with one key at any time. A planned change stages the next key with a switch time `T`:

1. `impz identity key stage --at <T>` writes the next key beside the current one. From then on the
   document holds both keys, and `retire` names the current key with `at` set to `T`.
2. Before `T`, the operator puts that document in every service that trusts the host.
3. At `T`, impd signs with the next key and deletes the old private key. An impd that starts after
   `T` switches at its start. The document then holds the new key only.
4. After `T` plus `W`, the operator puts that document in every service.

The service refuses a token whose key the document retires when the token's `iat` is `T` or later,
and refuses every token of that key when its own clock reads `T` plus `L` or later. The second rule
reads the service's clock, so a service up to `G` behind impd still ends the old key within `W` of
`T` in impd's time. With K1 for the old key and K2 for the new one:

| Time             | impd signs with | The service accepts                  |
| ---------------- | --------------- | ------------------------------------ |
| Before step 2    | K1              | K1                                   |
| Step 2 to `T`    | K1              | K1; K2, which signs nothing yet      |
| `T` to `T` + `L` | K2              | K2; a K1 token with `iat` before `T` |
| From `T` + `L`   | K2              | K2 only, with or without step 4      |

So the service never accepts an unknown key, and the old key ends `W` after `T` with no step by the
operator. K2's private key is in impd's data directory before `T`, under the same protection as K1.
A service that missed step 2 refuses each K2 token until it gets the document. A staged change has
no cancel, because the services already hold the `retire` entry, and a cancel would make them refuse
every token after `T`.

When the private key may have leaked, the holder signs tokens until the services drop the key, so
the order is the reverse, and identity requests fail while it runs: the operator removes the host's
document from every service, stops impd, removes `<data>/broker/identity/`, starts impd, which makes
a new key, and puts the new document in every service.

## The strip rule

On every request and every WebSocket handshake that a terminator sends, the broker deletes each
header whose name equals `imp-identity` after lower-casing and after each `_` becomes `-`. That
covers every case variant, the underscore variants that some servers fold into the same name, and
repeated lines. The delete runs with or without `identity` on the rule, so a service behind a
terminator never receives a guest's copy.

The order matters. The broker first drops the hop-by-hop headers and each header that the guest's
`Connection` names, then strips, then sets the credential, then sets the token last. A guest that
sends `Connection: imp-identity` removes only its own copy, and nothing the guest sent can follow or
replace the token. impd refuses a secret whose header is `imp-identity`, as it refuses the
method-override names.

## The secret field

A rule of a `static` or `oauth` secret carries `identity: true`, which `impz secret add --identity`
sets on each rule. A preset refuses it. The field is part of the secret's binding: adding or
removing it on a stored secret fails with `binding_changed` unless the call rebinds, which drops
every grant of the secret. The rules are JSON in the secret's row, so the field needs no migration.
`system.info().features.secretIdentity` is true on an impd that reads the field and has an issuer,
and the CLI checks it before it stores anything.

## Where it does not apply

- **A plain tunnel.** A host without a grant, and any port but 443, gets a TCP tunnel that the
  broker never reads. The broker neither strips nor adds there.
- **Traffic that is not HTTP,** and a tool that ignores `HTTPS_PROXY` or keeps its own trust store.
- **HTTP/2 and gRPC.** The terminator serves HTTP/1.1 only. A client that falls back gets the token;
  gRPC cannot fall back, so OTLP must use its HTTP form.
- **A WebSocket's messages.** The handshake carries the token. The messages after it carry none, so
  the service binds the connection to the imp at the handshake.
- **A long request.** The service checks `exp` when the request starts. A stream that runs past
  `exp` stays open.
- **A process without the broker's variables,** such as a service from the image's service files.
  Its request reaches no terminator, so the service receives no token and refuses the request.
- **The method and path.** The token does not bind to them, so a replay within `W` reaches another
  route of the same audience, and only with the service's credential too.

## Threats

| Threat                                                             | Outcome                                                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| The guest sends its own `Imp-Identity`                             | stopped: the broker strips it, and a forged token fails the signature  |
| The guest reaches the service by another path                      | stopped: it holds no token for its own identity and no credential      |
| A stolen credential                                                | the thief calls the service, but names no imp                          |
| A token read from a log or the wire                                | replays for up to `W`, to the same audience, with the credential       |
| A token sent to one service, replayed to another                   | stopped by `aud`                                                       |
| A backup of a running imp, restored on a second host               | stopped: the copy's tokens carry the second host's issuer              |
| A second trusted host signs a token that names the first           | stopped: the service checks a token against the keys of its own issuer |
| An old key after a planned key change                              | stopped from `W` after the switch time, by the `retire` entry          |
| A token with an issuer the service does not hold                   | stopped: the service refuses it before the signature check             |
| A compromised host, or a read of the signing key                   | not stopped: the holder signs any identity                             |
| Two processes in one imp                                           | not separated: both carry the imp's identity                           |
| A service that skips the issuer, signature, audience or time check | not stopped: the header is then a plain claim                          |
| Two running impds with one issuer                                  | not stopped: the pair of issuer and ID then names two imps             |
