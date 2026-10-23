import { expect, test } from 'bun:test';
import { parseQuery } from './router';
import {
  checkCreateBody,
  checkImageReference,
  checkNoQuery,
  checkPullQuery,
  checkRemoveQuery,
} from './rules';

test.each([
  ['localhost/x', "registry localhost is the host's own"],
  ['localhost:5000/x', "registry localhost:5000 is the host's own"],
  ['reg.localhost/x', "registry reg.localhost is the host's own"],
  ['127.0.0.1:5000/x', 'registry 127.0.0.1:5000 is an IP address'],
  ['169.254.169.254/x', 'registry 169.254.169.254 is an IP address'],
  ['[::1]:5000/x', 'image "[::1]:5000/x" is not a reference'],
  ['[fe80::1]/x', 'image "[fe80::1]/x" is not a reference'],
  [
    'ghcr.io/zgeoff/imp-host:other',
    'image ghcr.io/zgeoff/imp-host:other is the repository imp-host runs from',
  ],
  [
    'ghcr.io/zgeoff/imp-host@sha256:aa',
    'image ghcr.io/zgeoff/imp-host@sha256:aa is the repository imp-host runs from',
  ],
  ['-busybox', 'image "-busybox" is not a reference'],
  ['busy box', 'image "busy box" is not a reference'],
])('#checkImageReference refuses the image %s', (reference, reason) => {
  expect(checkImageReference(reference, 'ghcr.io/zgeoff/imp-host:latest')).toStrictEqual({
    isOk: false,
    reason,
  });
});

test('#checkImageReference refuses the repository of a host image on Docker Hub', () => {
  expect(checkImageReference('imp-host:dev', 'imp-host:dev')).toStrictEqual({
    isOk: false,
    reason: 'image imp-host:dev is the repository imp-host runs from',
  });
});

test('#checkImageReference refuses the repository of a host image pinned by digest', () => {
  expect(
    checkImageReference(
      'ghcr.io/zgeoff/imp-host:latest',
      'ghcr.io/zgeoff/imp-host:0.25.1@sha256:aa',
    ),
  ).toStrictEqual({
    isOk: false,
    reason: 'image ghcr.io/zgeoff/imp-host:latest is the repository imp-host runs from',
  });
});

test('#checkImageReference passes another repository of the host image registry', () => {
  expect(
    checkImageReference('ghcr.io/zgeoff/other:latest', 'ghcr.io/zgeoff/imp-host:latest'),
  ).toStrictEqual({ isOk: true });
});

test('#checkPullQuery passes a pull of IMP_BUILD_IMAGE by its digest as docker pull sends it', () => {
  const query = parseQuery(`fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=sha256%3A${'d'.repeat(64)}`);

  expect(
    checkPullQuery(
      query,
      'ghcr.io/zgeoff/imp-host:latest',
      `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    ),
  ).toStrictEqual({ isOk: true });
});

test.each([
  ['fromSrc=-&repo=x', 'param fromSrc is not allowed'],
  [
    `fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=sha256%3A${'d'.repeat(64)}&changes=CMD`,
    'param changes is not allowed',
  ],
  [
    `fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=sha256%3A${'d'.repeat(64)}&repo=x`,
    'param repo is not allowed',
  ],
  [
    `fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=sha256%3A${'d'.repeat(64)}&tag=sha256%3A${'d'.repeat(64)}`,
    'param tag is given 2 times',
  ],
  ['fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=a%20b', 'param tag is "a b"'],
  [`tag=sha256%3A${'d'.repeat(64)}`, 'param fromImage is missing'],
  ['fromImage=ghcr.io%2Fzgeoff%2Fimp-base', 'param tag is missing'],
])('#checkPullQuery refuses the pull query %s', (raw, reason) => {
  expect(
    checkPullQuery(
      parseQuery(raw),
      'ghcr.io/zgeoff/imp-host:latest',
      `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    ),
  ).toStrictEqual({ isOk: false, reason });
});

test.each([
  ['127.0.0.1:5000/zgeoff/imp-base', 'registry 127.0.0.1:5000 is an IP address'],
  ['localhost/zgeoff/imp-base', "registry localhost is the host's own"],
  ['ghcr.io/zgeoff/imp-host', 'image ghcr.io/zgeoff/imp-host is the repository imp-host runs from'],
])('#checkPullQuery refuses a pull of %s that IMP_BUILD_IMAGE names', (repository, reason) => {
  const query = new URLSearchParams({
    fromImage: repository,
    tag: `sha256:${'d'.repeat(64)}`,
  }).toString();

  expect(
    checkPullQuery(
      parseQuery(query),
      'ghcr.io/zgeoff/imp-host:latest',
      `${repository}:0.29.0@sha256:${'d'.repeat(64)}`,
    ),
  ).toStrictEqual({ isOk: false, reason });
});

test.each([
  ['docker.io/library/busybox', '1.37'],
  ['ghcr.io/zgeoff/imp-base', '0.29.0'],
  ['ghcr.io/zgeoff/imp-base', `sha256:${'e'.repeat(64)}`],
  ['ghcr.io/zgeoff/imp-other', `sha256:${'d'.repeat(64)}`],
  ['docker.io/zgeoff/imp-base', `sha256:${'d'.repeat(64)}`],
  [`ghcr.io/zgeoff/imp-base@sha256:${'e'.repeat(64)}`, `sha256:${'e'.repeat(64)}`],
])('#checkPullQuery refuses a pull of %s at %s, which is not IMP_BUILD_IMAGE', (fromImage, tag) => {
  const only = `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`;

  const query = new URLSearchParams({ fromImage, tag }).toString();

  expect(checkPullQuery(parseQuery(query), 'ghcr.io/zgeoff/imp-host:latest', only)).toStrictEqual({
    isOk: false,
    reason: `a pull of ${fromImage}:${tag} is refused: the proxy pulls only IMP_BUILD_IMAGE, ${only}`,
  });
});

test('#checkRemoveQuery passes the force docker rm -f sends', () => {
  expect(checkRemoveQuery(parseQuery('force=1'))).toStrictEqual({ isOk: true });
});

test.each([
  ['force=1&link=1', 'param link is not allowed'],
  ['force=1&v=1', 'param v is not allowed'],
  ['link=1', 'param link is not allowed'],
  ['force=yes', 'param force is "yes"'],
])('#checkRemoveQuery refuses the remove query %s', (raw, reason) => {
  expect(checkRemoveQuery(parseQuery(raw))).toStrictEqual({ isOk: false, reason });
});

test('#checkNoQuery passes a call with no params', () => {
  expect(checkNoQuery(parseQuery(''))).toStrictEqual({ isOk: true });
});

test('#checkNoQuery refuses a call with a param', () => {
  expect(checkNoQuery(parseQuery('name=x'))).toStrictEqual({
    isOk: false,
    reason: 'param name is not allowed',
  });
});

// The docker 29.8 CLI sends this body for `docker create <image> /bin/true`.
test('#checkCreateBody passes a create body as docker create sends it', () => {
  const body = {
    Hostname: '',
    Domainname: '',
    User: '',
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: null,
    Cmd: ['/bin/true'],
    Image: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    Volumes: {},
    WorkingDir: '',
    Entrypoint: null,
    OnBuild: null,
    Labels: {},
    HostConfig: {
      Binds: null,
      ContainerIDFile: '',
      LogConfig: { Type: '', Config: {} },
      NetworkMode: 'default',
      PortBindings: {},
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,
      VolumeDriver: '',
      VolumesFrom: null,
      ConsoleSize: [0, 0],
      CapAdd: null,
      CapDrop: null,
      Privileged: false,
      Mounts: null,
      Devices: [],
      MemorySwappiness: -1,
    },
    NetworkingConfig: {
      EndpointsConfig: { default: { IPAMConfig: null, Links: null, Aliases: null } },
    },
  };

  expect(
    checkCreateBody(
      body,
      'ghcr.io/zgeoff/imp-host:latest',
      `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    ),
  ).toStrictEqual({
    isOk: true,
    image: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
  });
});

test('#checkCreateBody refuses a create body with another command', () => {
  const body = {
    Hostname: '',
    Domainname: '',
    User: '',
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: null,
    Cmd: ['/bin/sh'],
    Image: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    Volumes: {},
    WorkingDir: '',
    Entrypoint: null,
    OnBuild: null,
    Labels: {},
    HostConfig: {
      Binds: null,
      ContainerIDFile: '',
      LogConfig: { Type: '', Config: {} },
      NetworkMode: 'default',
      PortBindings: {},
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,
      VolumeDriver: '',
      VolumesFrom: null,
      ConsoleSize: [0, 0],
      CapAdd: null,
      CapDrop: null,
      Privileged: false,
      Mounts: null,
      Devices: [],
      MemorySwappiness: -1,
    },
    NetworkingConfig: {
      EndpointsConfig: { default: { IPAMConfig: null, Links: null, Aliases: null } },
    },
  };

  expect(
    checkCreateBody(
      body,
      'ghcr.io/zgeoff/imp-host:latest',
      `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    ),
  ).toStrictEqual({
    isOk: false,
    reason: 'Cmd is ["/bin/sh"], not ["/bin/true"]',
  });
});

test.each([
  ['Entrypoint', ['/bin/sh']],
  ['Labels', { team: 'web' }],
  ['Volumes', { '/x': {} }],
  ['Env', ['A=1']],
  ['User', 'root'],
  ['AttachStdin', true],
  ['Healthcheck', { Test: ['CMD', 'x'] }],
])('#checkCreateBody refuses a create body that sets %s', (key, value) => {
  const body = {
    Hostname: '',
    Domainname: '',
    User: '',
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: null,
    Cmd: ['/bin/true'],
    Image: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    Volumes: {},
    WorkingDir: '',
    Entrypoint: null,
    OnBuild: null,
    Labels: {},
    HostConfig: {
      Binds: null,
      ContainerIDFile: '',
      LogConfig: { Type: '', Config: {} },
      NetworkMode: 'default',
      PortBindings: {},
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,
      VolumeDriver: '',
      VolumesFrom: null,
      ConsoleSize: [0, 0],
      CapAdd: null,
      CapDrop: null,
      Privileged: false,
      Mounts: null,
      Devices: [],
      MemorySwappiness: -1,
    },
    NetworkingConfig: {
      EndpointsConfig: { default: { IPAMConfig: null, Links: null, Aliases: null } },
    },
    [key]: value,
  };

  expect(
    checkCreateBody(
      body,
      'ghcr.io/zgeoff/imp-host:latest',
      `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    ),
  ).toStrictEqual({
    isOk: false,
    reason: `${key} is set`,
  });
});

test.each([
  ['Privileged', true],
  ['Binds', ['/:/host']],
  ['Mounts', [{ Type: 'bind', Source: '/', Target: '/host' }]],
  ['CapAdd', ['SYS_ADMIN']],
  ['Devices', [{ PathOnHost: '/dev/kvm' }]],
  ['NetworkMode', 'host'],
  ['PidMode', 'host'],
  ['IpcMode', 'host'],
  ['UsernsMode', 'host'],
  ['SecurityOpt', ['seccomp=unconfined']],
  ['VolumesFrom', ['imp-host']],
  ['RestartPolicy', { Name: 'always', MaximumRetryCount: 0 }],
  ['MemorySwappiness', 60],
  ['Tmpfs', { '/x': '' }],
  ['Runtime', 'runc'],
  ['CgroupParent', '/'],
  ['PortBindings', { '22/tcp': [{ HostPort: '22' }] }],
  ['Sysctls', { 'kernel.core_pattern': '|/x' }],
  ['DeviceRequests', [{ Driver: 'nvidia', Count: -1 }]],
  ['DeviceCgroupRules', ['b 7:* rmw']],
  ['PidMode', 'container:imp-host'],
])('#checkCreateBody refuses a create body whose HostConfig sets %s to %p', (key, value) => {
  const body = {
    Hostname: '',
    Domainname: '',
    User: '',
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: null,
    Cmd: ['/bin/true'],
    Image: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    Volumes: {},
    WorkingDir: '',
    Entrypoint: null,
    OnBuild: null,
    Labels: {},
    HostConfig: {
      Binds: null,
      ContainerIDFile: '',
      LogConfig: { Type: '', Config: {} },
      NetworkMode: 'default',
      PortBindings: {},
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,
      VolumeDriver: '',
      VolumesFrom: null,
      ConsoleSize: [0, 0],
      CapAdd: null,
      CapDrop: null,
      Privileged: false,
      Mounts: null,
      Devices: [],
      MemorySwappiness: -1,
      [key]: value,
    },
    NetworkingConfig: {
      EndpointsConfig: { default: { IPAMConfig: null, Links: null, Aliases: null } },
    },
  };

  expect(
    checkCreateBody(
      body,
      'ghcr.io/zgeoff/imp-host:latest',
      `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    ),
  ).toStrictEqual({
    isOk: false,
    reason: `HostConfig.${key} is set`,
  });
});

test('#checkCreateBody refuses a create body whose HostConfig is not an object', () => {
  const body = {
    Hostname: '',
    Domainname: '',
    User: '',
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: null,
    Cmd: ['/bin/true'],
    Image: `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    Volumes: {},
    WorkingDir: '',
    Entrypoint: null,
    OnBuild: null,
    Labels: {},
    HostConfig: 'host',
    NetworkingConfig: {
      EndpointsConfig: { default: { IPAMConfig: null, Links: null, Aliases: null } },
    },
  };

  expect(
    checkCreateBody(
      body,
      'ghcr.io/zgeoff/imp-host:latest',
      `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    ),
  ).toStrictEqual({
    isOk: false,
    reason: 'HostConfig is not an object',
  });
});

test.each([
  [`127.0.0.1:5000/x:1@sha256:${'d'.repeat(64)}`, 'registry 127.0.0.1:5000 is an IP address'],
  [`localhost:5000/x:1@sha256:${'d'.repeat(64)}`, "registry localhost:5000 is the host's own"],
  [
    `ghcr.io/zgeoff/imp-host:1@sha256:${'d'.repeat(64)}`,
    `image ghcr.io/zgeoff/imp-host:1@sha256:${'d'.repeat(64)} is the repository imp-host runs from`,
  ],
])('#checkCreateBody refuses a create from %s that IMP_BUILD_IMAGE names', (image, reason) => {
  const body = {
    Hostname: '',
    Domainname: '',
    User: '',
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: null,
    Cmd: ['/bin/true'],
    Image: image,
    Volumes: {},
    WorkingDir: '',
    Entrypoint: null,
    OnBuild: null,
    Labels: {},
    HostConfig: {
      Binds: null,
      ContainerIDFile: '',
      LogConfig: { Type: '', Config: {} },
      NetworkMode: 'default',
      PortBindings: {},
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,
      VolumeDriver: '',
      VolumesFrom: null,
      ConsoleSize: [0, 0],
      CapAdd: null,
      CapDrop: null,
      Privileged: false,
      Mounts: null,
      Devices: [],
      MemorySwappiness: -1,
    },
    NetworkingConfig: {
      EndpointsConfig: { default: { IPAMConfig: null, Links: null, Aliases: null } },
    },
  };

  expect(checkCreateBody(body, 'ghcr.io/zgeoff/imp-host:latest', image)).toStrictEqual({
    isOk: false,
    reason,
  });
});

test('#checkCreateBody refuses a create body that is not an object', () => {
  expect(
    checkCreateBody(
      [],
      'ghcr.io/zgeoff/imp-host:latest',
      `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    ),
  ).toStrictEqual({
    isOk: false,
    reason: 'the body is not a JSON object',
  });
});

test('#checkCreateBody refuses a create body with no Image', () => {
  const body = {
    Hostname: '',
    Domainname: '',
    User: '',
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: null,
    Cmd: ['/bin/true'],
    Image: 1,
    Volumes: {},
    WorkingDir: '',
    Entrypoint: null,
    OnBuild: null,
    Labels: {},
    HostConfig: {
      Binds: null,
      ContainerIDFile: '',
      LogConfig: { Type: '', Config: {} },
      NetworkMode: 'default',
      PortBindings: {},
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,
      VolumeDriver: '',
      VolumesFrom: null,
      ConsoleSize: [0, 0],
      CapAdd: null,
      CapDrop: null,
      Privileged: false,
      Mounts: null,
      Devices: [],
      MemorySwappiness: -1,
    },
    NetworkingConfig: {
      EndpointsConfig: { default: { IPAMConfig: null, Links: null, Aliases: null } },
    },
  };

  expect(
    checkCreateBody(
      body,
      'ghcr.io/zgeoff/imp-host:latest',
      `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`,
    ),
  ).toStrictEqual({
    isOk: false,
    reason: 'Image is missing',
  });
});

test.each([
  [`ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`],
  [`ghcr.io/zgeoff/imp-base@sha256:${'d'.repeat(64)}`],
])('#checkCreateBody passes a create from IMP_BUILD_IMAGE as %s', (image) => {
  const only = `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`;

  const body = {
    Hostname: '',
    Domainname: '',
    User: '',
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: null,
    Cmd: ['/bin/true'],
    Image: image,
    Volumes: {},
    WorkingDir: '',
    Entrypoint: null,
    OnBuild: null,
    Labels: {},
    HostConfig: {
      Binds: null,
      ContainerIDFile: '',
      LogConfig: { Type: '', Config: {} },
      NetworkMode: 'default',
      PortBindings: {},
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,
      VolumeDriver: '',
      VolumesFrom: null,
      ConsoleSize: [0, 0],
      CapAdd: null,
      CapDrop: null,
      Privileged: false,
      Mounts: null,
      Devices: [],
      MemorySwappiness: -1,
    },
    NetworkingConfig: {
      EndpointsConfig: { default: { IPAMConfig: null, Links: null, Aliases: null } },
    },
  };

  expect(checkCreateBody(body, 'ghcr.io/zgeoff/imp-host:latest', only)).toStrictEqual({
    isOk: true,
    image,
  });
});

test.each([
  ['busybox'],
  ['ghcr.io/zgeoff/imp-base:0.29.0'],
  [`ghcr.io/zgeoff/imp-base@sha256:${'e'.repeat(64)}`],
  [`ghcr.io/zgeoff/imp-other@sha256:${'d'.repeat(64)}`],
  [`sha256:${'d'.repeat(64)}`],
])('#checkCreateBody refuses a create from %s, which is not IMP_BUILD_IMAGE', (image) => {
  const only = `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`;

  const body = {
    Hostname: '',
    Domainname: '',
    User: '',
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: null,
    Cmd: ['/bin/true'],
    Image: image,
    Volumes: {},
    WorkingDir: '',
    Entrypoint: null,
    OnBuild: null,
    Labels: {},
    HostConfig: {
      Binds: null,
      ContainerIDFile: '',
      LogConfig: { Type: '', Config: {} },
      NetworkMode: 'default',
      PortBindings: {},
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,
      VolumeDriver: '',
      VolumesFrom: null,
      ConsoleSize: [0, 0],
      CapAdd: null,
      CapDrop: null,
      Privileged: false,
      Mounts: null,
      Devices: [],
      MemorySwappiness: -1,
    },
    NetworkingConfig: {
      EndpointsConfig: { default: { IPAMConfig: null, Links: null, Aliases: null } },
    },
  };

  expect(checkCreateBody(body, 'ghcr.io/zgeoff/imp-host:latest', only)).toStrictEqual({
    isOk: false,
    reason: `a create from ${image} is refused: the proxy creates only from IMP_BUILD_IMAGE, ${only}`,
  });
});
