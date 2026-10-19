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
