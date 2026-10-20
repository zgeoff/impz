// @impz/daemon/testing: a real impd for another package's tests, and the
// stand-ins those tests share
export { startTestImpd } from './start-test-impd';
export type { TestImpd, TestImpdOptions } from './start-test-impd';
export { TEST_TOKEN } from './test-token';
export { buildStubImpdReleaseFetch } from './surface/build-stub-impd-release-fetch';
export type { StubImpdReleaseOptions } from './surface/build-stub-impd-release-fetch';
export { startStubImpdRelease } from './surface/start-stub-impd-release';
export { createStubDockerCli } from './imps/create-stub-docker-cli';
export type { StubDockerCliOptions, StubDockerImage } from './imps/create-stub-docker-cli';
export { startStubDockerEngine } from './imps/start-stub-docker-engine';
export type { StubDockerEngineOptions, StubEngineAnswer } from './imps/start-stub-docker-engine';
export { createMoveHosts, createUbuntuImage } from './imp-ops/create-move-hosts';
export type { MoveHostsOptions } from './imp-ops/create-move-hosts';
export { createPendingSignIn } from './identity/create-pending-sign-in';
export { buildMockNewImage } from './imps/build-mock-new-image';
export { buildMockNewImp } from './imps/build-mock-new-imp';
export { buildStubTracedBuild } from './imps/build-stub-traced-build';
export { buildStubBrokerTokenEndpoint } from './network/build-stub-broker-token-endpoint';
export { buildStubCloudflareApi } from './network/build-stub-cloudflare-api';
export { startStubSilentOrigin } from './network/start-stub-silent-origin';
export { buildQueryGate } from './platform/build-query-gate';
export { buildStubClock } from './platform/build-stub-clock';
export { findFreePorts } from './platform/find-free-ports';
export { buildStubExecGuest } from './vm/build-stub-exec-guest';
export { buildStubExecReplies } from './vm/build-stub-exec-replies';
export { startStubAgent } from './vm/start-stub-agent';
export type { StubAgentHandler } from './vm/start-stub-agent';
export { startStubDialAgent } from './vm/start-stub-dial-agent';
export { startStubExecAgent } from './vm/start-stub-exec-agent';
export { startStubInnerAgent } from './vm/start-stub-inner-agent';
export { startStubServiceAgent } from './vm/start-stub-service-agent';

// where impd keeps an image's and an imp's files in its data dir, for a test
// that seeds or reads them
export { buildImagePaths, buildImpPaths } from '../src/vm/storage/data-layout';
