// The Dockerfile frontend every image build runs, by digest; BUILDKIT_SYNTAX
// wins over a `# syntax=` line. The same pin as host/Dockerfile's first
// line: bump both at once.
export const DOCKERFILE_FRONTEND =
  'docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b';
