# Imp identity for services

The credential broker can tell a service which imp sent a request. It adds an `Imp-Identity` header
that holds a token signed by impd, and removes every copy of that header the guest sends, so the
guest cannot write it. A service that keeps state for each imp, such as a task service where each
imp closes its own tasks, verifies the token and keys that state on the imp it names.
[Imp identity](../architecture/network/identity.md) explains what the token proves and what it does
not.

All values below are invented.

## Turn it on

1. Give the host an issuer, and restart impd. The issuer names this impd in every token. Two running
   impds never share one.

   ```sh
   IMP_IDENTITY_ISSUER=imp-host-a
   ```

   Expect: `impz info --json` shows `secretIdentity` as true under `features`, and `impz info` shows
   the issuer. Without the setting, the feature is off and step 2 fails.

2. Store the service's token with `--identity`. Send the value on stdin.

   ```sh
   printf '%s' "$TASKS_TOKEN" | impz secret add tasks --kind static \
     --hosts tasks.imp.internal --upstream http://192.0.2.10:18090 --identity
   ```

   Expect: `impz secret ls` shows `tasks.imp.internal -> http://192.0.2.10:18090 (identity)`.

3. Grant the secret to the imp.

   ```sh
   impz grant dev-7f3a tasks
   ```

4. Print impd's public keys, and put the document in the service's configuration.

   ```sh
   impz identity jwks > imp-host-a.jwks.json
   ```

   Expect: a JWKS document with `"issuer": "imp-host-a"` and one `EC` key, `crv` `P-256`, with a
   `kid`.

5. Configure the service to accept only the audience `tasks.imp.internal`, and only the issuers
   whose documents it holds. The service holds one document for each host, and checks a token
   against the keys of the token's own issuer only. It refuses to start with two documents for one
   issuer.

`--identity` works with `--kind static` and `--kind oauth`, with or without `--upstream`. A preset
refuses it. `--identity` is part of the secret's binding: to add or remove it on a stored secret,
use `--replace --rebind`, which drops the secret's grants.

An impd from before this feature has no `features.secretIdentity` and drops the field unread. An
impd without an issuer reports the feature as false. `impz secret add --identity` checks the feature
first and fails before it stores anything.

## What the service receives

The guest sends this request through the broker. It carries a forged `Imp-Identity`, an underscore
variant, and a `Connection` header that names the header.

```http
POST /v1/sessions/close HTTP/1.1
Host: tasks.imp.internal
Authorization: Bearer imp-broker-placeholder
Imp-Identity: a-token-the-guest-made-up
imp_identity: forged-too
Connection: keep-alive, imp-identity
Content-Type: application/json

{"session":"5f0c9a2e-41d7-4c1b-9b7e-2a6d3e8f1c04"}
```

The service receives this request.

```http
POST /v1/sessions/close HTTP/1.1
Host: 192.0.2.10:18090
Authorization: Bearer <the real token>
Imp-Identity: eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Ik5tVjR...<signature>
Content-Type: application/json

{"session":"5f0c9a2e-41d7-4c1b-9b7e-2a6d3e8f1c04"}
```

The token's header and claims, decoded:

```json
{ "alg": "ES256", "typ": "JWT", "kid": "NmV4YW1wbGUta2V5LXRodW1icHJpbnQ" }
```

```json
{
  "iss": "imp-host-a",
  "sub": "0192f3a1-7b2c-7d4e-8f10-3a5b6c7d8e9f",
  "aud": "tasks.imp.internal",
  "iat": 1794355200,
  "exp": 1794355255,
  "jti": "b3f1c2d4e5a60718293a4b5c6d7e8f90",
  "imp_name": "dev-7f3a"
}
```

## What the service checks

A service written in TypeScript imports the checks from `@impz/client/identity`. The entry has no
dependency on the rest of the client. `verifyImpIdentity` takes the header and the pinned documents,
and answers the imp the token names, or `null` for a token the service must refuse.

```ts
import { loadIdentityIssuers, verifyImpIdentity } from '@impz/client/identity';

// at start: throws on an empty list or two documents with one issuer
const issuers = loadIdentityIssuers([hostA, hostB]);

const imp = await verifyImpIdentity(request.headers.get('imp-identity'), {
  issuers,
  audience: 'tasks.imp.internal',
  nowSeconds: Math.floor(Date.now() / 1000),
});
```

A service in another language does the same checks:

1. Check the bearer token, as before.
2. Refuse a request with no `Imp-Identity` header, or with more than one.
3. Refuse a token whose `iss` names no configured issuer.
4. Verify the signature against the keys of that issuer only. Accept `alg` `ES256` only. A key from
   another issuer's document never verifies the token.
5. Check that `aud` is the service's own name.
6. Check the times, with `now` from the service's clock.
   - Refuse when `exp - iat` is more than 55.
   - Refuse when `now` is more than `exp + 5`.
   - Refuse when `iat` is more than `now + 5`.

   The token's life (55 seconds) plus the leeway (5 seconds) is 60 seconds. So the service refuses
   every token from 61 seconds after its `iat`.

7. Refuse a token from a key that the document retires, when the token's `iat` is at or after the
   retire time, or when `now` is 55 seconds or more past the retire time
   ([replace the key](#replace-the-key)).
8. Use the pair of `iss` and `sub` as the imp. The same `sub` under another `iss` is another imp.
   Use `imp_name` for logs only.

`checkSessionImp` compares the verified imp with what a session host recorded for a session, and
refuses with `other-host` when the issuer differs. The session host reads the issuer from
`impz info` (`identity.issuer` in `--json`) of the impd it made the imp on.

## Replace the key

A planned change. The service learns the new key before impd signs with it, and the old key stops at
a time that the document itself carries. `T` is the switch time.

1. Stage the new key, and pick `T` far enough ahead to finish step 2. The change has no cancel.

   ```sh
   impz identity key stage --at 2026-12-01T03:00Z
   ```

   Expect: `impz identity jwks` shows two keys, and a `retire` entry with the old key's `kid` and
   `T` as `at`.

2. Before `T`, put the new document in every service that trusts this host.

   ```sh
   impz identity jwks > imp-host-a.jwks.json
   ```

3. Wait for `T`. impd then signs with the new key and deletes the old private key. A restart of impd
   after `T` does the same at its start.

   Expect: `impz identity jwks` shows the new key only.

4. After `T` plus 60 seconds, put that document in every service.

From step 2 the service refuses a token of the old key whose `iat` is `T` or later. A token of the
old key from before `T` ends 55 seconds after `T` at most, by the service's clock. So from `T` plus
60 seconds the service accepts no token of the old key, with or without step 4. A service that
missed step 2 refuses each token of the new key until it gets the document.

When the private key may have leaked, do not use the planned change: the holder of the key signs
tokens until `T`. Do these steps in this order. Each identity request fails between step 1 and
step 3.

1. Remove the host's document from every service.
2. Stop impd, remove `<data>/broker/identity/`, and start impd. impd makes a new key.
3. Print the new document with `impz identity jwks`, and put it in every service.

## Without the flag

On a secret without `--identity`, the broker still removes every `Imp-Identity` header the guest
sends, and adds none. A service behind the broker therefore never receives the guest's copy.
