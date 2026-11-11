# Coding imp example: images/base plus Claude Code and gh, for an agent that
# works on a repo. The broker adds the Claude and GitHub credentials to each
# request (docs/guides/coder.md), so the image holds none.
#   impz image build images/examples/coder --name coder
# The published images/base, pinned by digest, which brings git and curl.
FROM ghcr.io/zgeoff/imp-base:0.29.0@sha256:1851f631ea77f3a99b6f1f9af8ca8868434f4cd066158bcf9def8678c29b0c21

# Each download is pinned by version and sha256. A bump is a reviewed
# dependency change: take the new sum from the release's own list, never
# from the file it downloads.
# platforms["linux-x64"].checksum in
# https://downloads.claude.ai/claude-code-releases/<version>/manifest.json
ARG CLAUDE_CODE_VERSION=2.1.322
ARG CLAUDE_CODE_SHA256=bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478
# gh_<version>_checksums.txt in the cli/cli release
ARG GH_VERSION=2.103.3
ARG GH_SHA256=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d

# the native build would otherwise replace itself with an unpinned release
ENV DISABLE_UPDATES=1

# the pipe feeds echo into `sha256sum -c`, where only the check can fail
# hadolint ignore=DL4006
RUN set -eu; \
    curl -fsSLo /tmp/claude "https://downloads.claude.ai/claude-code-releases/$CLAUDE_CODE_VERSION/linux-x64/claude"; \
    echo "$CLAUDE_CODE_SHA256  /tmp/claude" | sha256sum -c -; \
    install -m 0755 /tmp/claude /usr/local/bin/claude; \
    gh_dir="gh_${GH_VERSION}_linux_amd64"; \
    curl -fsSLo /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v$GH_VERSION/$gh_dir.tar.gz"; \
    echo "$GH_SHA256  /tmp/gh.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tar.gz -C /tmp; \
    install -m 0755 "/tmp/$gh_dir/bin/gh" /usr/local/bin/gh; \
    install -D -m 0644 "/tmp/$gh_dir/LICENSE" /usr/share/doc/gh/LICENSE; \
    rm -rf /tmp/claude /tmp/gh.tar.gz "/tmp/$gh_dir"
