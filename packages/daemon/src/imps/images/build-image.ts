// impd and imp-docker-proxy both read this default, so the proxy's pull lock names the image
// impd adds.
export const DEFAULT_BUILD_IMAGE =
  'ghcr.io/zgeoff/imp-base:0.29.0@sha256:1851f631ea77f3a99b6f1f9af8ca8868434f4cd066158bcf9def8678c29b0c21';

export const BUILD_IMAGE_PATTERN = /^[\w.\/:\-]+@sha256:[a-f0-9]{64}$/v;
