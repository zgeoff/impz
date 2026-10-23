import { expect, test } from 'bun:test';
import { buildDevLayout } from './build-dev-layout.ts';

test('it lays out the default instance on the base ports', () => {
  expect(buildDevLayout({ env: {}, root: '/w/imp', cwd: '/w' })).toStrictEqual({
    name: 'imp-dev',
    proxy: 'imp-dev-docker-proxy',
    dataDir: '/w/imp/.data/dev',
    offset: 0,
    isPublished: true,
    apiURL: 'http://localhost:7070',
    apiPort: 7070,
    proxyPort: 7080,
    impPortBase: 20_000,
    sshPort: 2222,
    mcpPort: 7071,
  });
});

test('it shifts every published port by IMP_DEV_PORT_OFFSET', () => {
  expect(
    buildDevLayout({
      env: { IMP_DEV_NAME: 'imp-side', IMP_DEV_PORT_OFFSET: '100' },
      root: '/w/imp',
      cwd: '/w',
    }),
  ).toStrictEqual({
    name: 'imp-side',
    proxy: 'imp-side-docker-proxy',
    dataDir: '/w/imp/.data/dev',
    offset: 100,
    isPublished: true,
    apiURL: 'http://localhost:7170',
    apiPort: 7170,
    proxyPort: 7180,
    impPortBase: 20_100,
    sshPort: 2322,
    mcpPort: 7171,
  });
});

test('it resolves a relative IMP_DEV_DATA against the caller directory', () => {
  expect(
    buildDevLayout({ env: { IMP_DEV_DATA: 'data/side' }, root: '/w/imp', cwd: '/home/dev' })
      .dataDir,
  ).toBe('/home/dev/data/side');
});

test('it answers an unpublished instance on its own address and port 7070', () => {
  expect(
    buildDevLayout({
      env: { IMP_DEV_PUBLISH: '0', IMP_DEV_IP: '172.30.0.9', IMP_DEV_PORT_OFFSET: '5' },
      root: '/w/imp',
      cwd: '/w',
    }).apiURL,
  ).toBe('http://172.30.0.9:7070');
});

test('it refuses IMP_DEV_PUBLISH=0 without IMP_DEV_IP', () => {
  expect(() =>
    buildDevLayout({ env: { IMP_DEV_PUBLISH: '0' }, root: '/w/imp', cwd: '/w' }),
  ).toThrowWithMessage(Error, 'IMP_DEV_PUBLISH=0 needs IMP_DEV_IP');
});

test('it refuses an IMP_DEV_PORT_OFFSET that is not a whole number', () => {
  expect(() =>
    buildDevLayout({ env: { IMP_DEV_PORT_OFFSET: 'ten' }, root: '/w/imp', cwd: '/w' }),
  ).toThrowWithMessage(Error, "IMP_DEV_PORT_OFFSET must be a whole number, got 'ten'");
});
