import { expect, test } from 'bun:test';
import {
  BuildContextErrorSchema,
  BuildContextQuerySchema,
  BuildContextUploadSchema,
  DockerfilePathSchema,
} from './build-context-protocol';

test.each(['Dockerfile', 'docker/Dockerfile.dev', 'a..b/Dockerfile'])(
  '#DockerfilePathSchema accepts the path %s',
  (input) => {
    expect(DockerfilePathSchema.safeParse(input).data).toBe(input);
  },
);

test('#DockerfilePathSchema rejects an empty path', () => {
  const result = DockerfilePathSchema.safeParse('');

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_small' });
});

test.each(['/Dockerfile', '../Dockerfile', 'a/../../Dockerfile', String.raw`a\..\Dockerfile`])(
  '#DockerfilePathSchema rejects the path %s outside the context',
  (input) => {
    const result = DockerfilePathSchema.safeParse(input);

    expect(result.error?.issues).toPartiallyContain({
      path: [],
      message: 'the Dockerfile path must be relative and stay inside the build context',
    });
  },
);

test('#BuildContextQuerySchema accepts a name and a Dockerfile path', () => {
  const payload = { name: 'web', dockerfile: 'docker/Dockerfile' } as const;

  expect(BuildContextQuerySchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#BuildContextQuerySchema rejects a name that is not a valid name', () => {
  const result = BuildContextQuerySchema.safeParse({
    name: 'Web',
    dockerfile: 'docker/Dockerfile',
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['name'],
    message: 'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  });
});

test('#BuildContextQuerySchema rejects an absolute Dockerfile path', () => {
  const result = BuildContextQuerySchema.safeParse({ name: 'web', dockerfile: '/Dockerfile' });

  expect(result.error?.issues).toPartiallyContain({
    path: ['dockerfile'],
    message: 'the Dockerfile path must be relative and stay inside the build context',
  });
});

test('#BuildContextUploadSchema turns the date string into a date', () => {
  expect(
    BuildContextUploadSchema.safeParse({
      id: '0199f2b4-7c1e-7000-8000-4a1b2c3d4e5f',
      expiresAt: '2026-01-02T03:04:05.000Z',
    }).data,
  ).toStrictEqual({
    id: '0199f2b4-7c1e-7000-8000-4a1b2c3d4e5f',
    expiresAt: new Date('2026-01-02T03:04:05.000Z'),
  });
});

test('#BuildContextUploadSchema rejects an empty id', () => {
  const result = BuildContextUploadSchema.safeParse({
    id: '',
    expiresAt: '2026-01-02T03:04:05.000Z',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['id'], code: 'too_small' });
});

test('#BuildContextUploadSchema rejects a date string that is not a date', () => {
  const result = BuildContextUploadSchema.safeParse({
    id: '0199f2b4-7c1e-7000-8000-4a1b2c3d4e5f',
    expiresAt: 'tomorrow',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['expiresAt'], code: 'invalid_type' });
});

test('#BuildContextErrorSchema rejects an error without a code', () => {
  const result = BuildContextErrorSchema.safeParse({ message: 'the upload failed' });

  expect(result.error?.issues).toPartiallyContain({ path: ['code'], code: 'invalid_type' });
});

test('#BuildContextErrorSchema rejects a message that is not a string', () => {
  const result = BuildContextErrorSchema.safeParse({ code: 'PAYLOAD_TOO_LARGE', message: 42 });

  expect(result.error?.issues).toPartiallyContain({ path: ['message'], code: 'invalid_type' });
});

test('#BuildContextErrorSchema accepts a code and a message', () => {
  const payload = { code: 'PAYLOAD_TOO_LARGE', message: 'the upload is too large' } as const;

  expect(BuildContextErrorSchema.safeParse(payload).data).toStrictEqual(payload);
});
