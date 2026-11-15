# mcp-reads

Run this journey on the `local` target. Before it, run `bun verify use --target local`,
`bun verify up` and `bun verify doctor`. When your task says impd was deployed, or names `prod`,
also run the reads in [On prod](#on-prod) after `done` on `local`.

The journey checks that an MCP client with no person present can read impd through the public MCP
route: the imps, the images and the event log. Each `mcp` command signs in as the run's service
client for you, so you pass no token. The journey makes `wv-mcp-reads` with impd's root token, so
the reads have an imp to find, and destroys it at the end.

- Check `data.isError` on each `mcp call`. A tool that fails still gives `ok: true` on the envelope,
  with `data.isError: true` and the reason in `data.content[0].text`.
- When a step gives a result that the end state doesn't expect, run the destroy step at once, so the
  next run starts with no `wv-mcp-reads`. Then go on as step 5 of the skill's "Check a change" says.

## Journey

```bash
bun verify use --feature mcp-reads
bun verify action create-imp --name wv-mcp-reads
bun verify mcp tools
bun verify mcp call imp_list
bun verify mcp call imp_image_list
bun verify mcp call imp_event_list --args '{"limit":1000}'
bun verify action destroy-imp --name wv-mcp-reads
```

## End state

Each field below sits under `data`. Another journey on the same run can leave more imps and events,
so each list holds at least what the end state names.

- `mcp tools` gives `server: "impz"` and 15 tools. These five have `inReadTools: true`, and the
  others `false`:
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

On `prod` you only read, as the read client `service:wringer-ro`. impd gives that client the `read`
scope on every imp, and the target refuses every write before it leaves. Run no action, and no
`done`. The imp names and events on `prod` show the owner's work, so give only counts and `isError`
in your reply, never a name, and paste nothing from the run's evidence.

1. Run `bun verify down` to end the `local` run. Then run `bun verify use --target prod` and
   `bun verify use --feature mcp-reads`.
2. Start the run. 1Password keeps the read client in the item `impz verify prod mcp client`: the
   deployed origin in its `origin` field, and the secret in `credential`. `IMP_OP_VAULT` names the
   vault. When it is empty, stop, and report that you could not reach the item. Set both variables
   on the `attach` command alone, and never print the secret. `attach` starts the run's supervisor,
   which keeps the secret and signs in for each later `mcp` command.

   ```bash
   IMPZ_VERIFY_PROD_ORIGIN="$(op read "op://$IMP_OP_VAULT/impz verify prod mcp client/origin")" \
     IMPZ_VERIFY_PROD_SECRET="$(op read "op://$IMP_OP_VAULT/impz verify prod mcp client/credential")" \
     bun verify attach
   ```

   Expect: `ok: true` and `data.status` `running`.

3. Run `bun verify doctor`. On `prod`, `mcp-route` checks that the route answers and offers the
   `client_credentials` grant, and `service-client` checks that the read client signs in. `host` and
   `impd-ready` report `skipped`.

   Expect: `data.passed: true`. When a check fails, run step 5, and report the check and its
   `message`. The operator of the deployed impd fixes it: its two service-client files must hold the
   digest in the item's `digest` field, and the client `wringer-ro`.

4. List the tools, then run the three reads:

   ```bash
   bun verify mcp tools
   bun verify mcp call imp_list
   bun verify mcp call imp_image_list
   bun verify mcp call imp_event_list --args '{"limit":5}'
   ```

   Expect: `mcp tools` gives exactly the five tools of the `read` scope, each with
   `inReadTools: true`. Each call gives `isError: false`.

5. Run `bun verify detach`, then `bun verify use --target local`. `detach` removes the run's
   `secrets.ndjson`, where the run keeps the secret to scrub it from the evidence. Run
   `bun verify publish` after it, with no new `up`.
