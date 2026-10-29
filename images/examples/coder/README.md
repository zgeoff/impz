# coder

`coder` is an imp for a coding agent: the published base image with Claude Code and gh added, each
pinned by version and sha256. The image holds no credential. The
[credential broker](../../../docs/guides/connectors.md) adds your Claude and GitHub tokens to the
imp's requests to their hosts, and the guest holds only a placeholder.

## Start a coding imp

1. Build the image from the repo root:

   ```bash
   impz image build images/examples/coder --name coder
   ```

2. Store your Claude credential. For a Claude subscription, make a long-lived token with
   `claude setup-token` on your own machine, then paste it at the prompt:

   ```bash
   impz secret add claude --kind static --hosts api.anthropic.com --env CLAUDE_CODE_OAUTH_TOKEN
   ```

   For an API key, run `impz secret add claude --preset anthropic` instead. Claude Code then asks
   once, in its first interactive session, to use the key.

3. Store a GitHub token, pasted at the prompt: `impz secret add gh --preset github`.

4. Start an imp from the image, and grant it both secrets:

   ```bash
   impz new box --image coder
   impz grant box claude
   impz grant box gh
   ```

   Expect: `impz exec box -- gh api user --jq .login` prints your GitHub login.

5. Clone a repo, and open a shell in the imp:

   ```bash
   impz exec box -- gh repo clone <owner>/<repo> /root/<repo>
   impz console box
   ```

6. In that shell, give git your name and email for commits, and run Claude Code on the repo:

   ```bash
   git config --global user.name '<your name>'
   git config --global user.email '<your email>'
   cd /root/<repo> && claude
   ```

`git push` and `gh pr create` work in the imp with the broker's GitHub token.

## Check an image for secrets

[`check-no-secrets.sh`](./check-no-secrets.sh) checks each layer of an image in the local Docker for
the login files of Claude Code, gh and git, and for Anthropic and GitHub tokens. It checks the
image's env and build history for them too. It finds no other kind of secret, so check the image for
any other credential yourself. Run it on any image you build from this one before you share it:

```bash
docker build -t coder images/examples/coder
images/examples/coder/check-no-secrets.sh coder
```

Expect: `check-no-secrets: ok (coder, sha256:<image_id>)`.
