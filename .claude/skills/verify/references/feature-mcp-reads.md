# mcp-reads

[Journey](#journey) · [End state](#end-state) · [On prod](#on-prod)

Run this journey on the `local` target. Before it, run `bun verify use --target local`,
`bun verify up` and `bun verify doctor`. When your task says impd was deployed, or names `prod`,
also run [On prod](#on-prod), after you have run `done` for each feature on `local` and before
`publish`.

The journey checks that an MCP client with no person present can read impd through the public MCP
route: the imps, the images and the event log. Each `mcp` command signs in as the run's service
client for you, so you pass no token. The journey makes `wv-mcp-reads` with impd's root token, so
the reads have an imp to find, and destroys it at the end.

- Check `data.isError` on each `mcp call`. A tool that fails still gives `ok: true` in the JSON line
  the command prints, with `data.isError: true` and the reason in `data.content[0].text`.
- When a step gives a result that the end state doesn't expect, run the destroy step at once, so the
  next run starts with no `wv-mcp-reads`. Then go on as step 5 of the skill's "Check a change" says.

## Journey

```bash
bun verify use --feature mcp-reads
bun verify action create-imp --name wv-mcp-reads
bun verify mcp tools
bun verify mcp call imp_list
bun verify mcp call imp_image_list
bun verify mcp call imp_event_list
bun verify action destroy-imp --name wv-mcp-reads
```

## End state

Each field below sits under `data`. Another journey on the same run can leave more imps, so each
list holds at least what the end state names. With no `after`, `imp_event_list` returns each imp as
it is now, as an `ImpAdded` event.

- `mcp tools` gives `server: "impz"` and exactly 15 tools. These five have `inReadTools: true`, and
  the others `false`:
  - `imp_list`
  - `imp_url`
  - `imp_image_list`
  - `imp_checkpoint_list`
  - `imp_event_list`
- `imp_list` gives `isError: false`, and `structuredContent.imps` holds `wv-mcp-reads` with
  `state: "running"`.
- `imp_image_list` gives `isError: false`, and `structuredContent.images` holds the image `tiny`.
- `imp_event_list` gives `isError: false`, and `structuredContent.events` holds an `ImpAdded` event
  whose `imp.name` is `wv-mcp-reads`.
- `destroy-imp` gives `existed: true`.

## On prod

These steps read the deployed impd as `service:wringer-ro`, a service client that impd gives the
`read` scope on every imp. The `prod` target sends no write: `bun verify` refuses each one on this
machine. Run no `action` command and no `done` there.

1. Run `bun verify down` to end the `local` run. Then run `bun verify use --target prod` and
   `bun verify use --feature mcp-reads`.

   Expect: `ok: true` from each.

2. Read the client from 1Password. The item `impz verify prod mcp client` holds the deployed origin
   in its `origin` field and the secret in `credential`. The environment variable `IMP_OP_VAULT`
   names its vault. When the variable is empty or an `op read` fails, stop, and report that you
   could not read the item.
3. Start the run with both values. Set them on the `attach` command alone, so no later command holds
   the secret. Never print the secret.

   ```bash
   IMPZ_VERIFY_PROD_ORIGIN="$(op read "op://$IMP_OP_VAULT/impz verify prod mcp client/origin")" \
     IMPZ_VERIFY_PROD_SECRET="$(op read "op://$IMP_OP_VAULT/impz verify prod mcp client/credential")" \
     bun verify attach
   ```

   Expect: `ok: true` and `data.status` `running`. When `attach` fails, go to step 6.

4. Run `bun verify doctor`. `mcp-route` checks that the route answers and offers the
   `client_credentials` grant. `service-client` checks that `wringer-ro` signs in. `host` and
   `impd-ready` report `skipped`.

   Expect: `data.passed: true`. When a check fails, go to step 6, and report the check's name and
   `message`. You cannot fix it from here: the deployed impd's service-token file must hold the
   digest in the item's `digest` field, and its service-clients file must name `wringer-ro`.

5. List the tools, then run the three reads. The event read returns every imp, whatever `limit` you
   pass.

   ```bash
   bun verify mcp tools
   bun verify mcp call imp_list
   bun verify mcp call imp_image_list
   bun verify mcp call imp_event_list
   ```

   Expect: `mcp tools` gives exactly the five tools of the `read` scope, each with
   `inReadTools: true`. Each call gives `isError: false`.

6. Run `bun verify detach`. It ends the run and removes its `secrets.ndjson`, the file where the run
   keeps the secret to scrub it from the evidence. Then run `bun verify use --target local`, and go
   on to `publish` as the skill says. `publish` puts only the verdicts from `local` in the PR.

   Expect: `ok: true` from each.

In your reply, give for `prod` the doctor's result, the number of tools, and for each read its
`isError` and the number of imps, images or events. The deployed imps and events show the owner's
work, so give no imp, image or event name, and paste nothing from the run's evidence under
`.wringer/`.
