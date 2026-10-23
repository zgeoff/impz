import { expect, test } from 'bun:test';
import { ImageOpEventSchema } from './image-op-event-schema';

test('it accepts a progress event', () => {
  const payload = { type: 'progress', phase: 'pull', elapsedMs: 0 } as const;

  expect(ImageOpEventSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('it accepts a progress event with its step', () => {
  const payload = {
    type: 'progress',
    phase: 'build',
    elapsedMs: 1500,
    step: '[2/4] RUN make all',
  } as const;

  expect(ImageOpEventSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('it accepts a log event', () => {
  const payload = { type: 'log', text: '#5 0.312 compiling main.c' } as const;

  expect(ImageOpEventSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('it rejects a log event longer than its limit', () => {
  const result = ImageOpEventSchema.safeParse({ type: 'log', text: 'x'.repeat(8193) });

  expect(result.error?.issues).toPartiallyContain({ path: ['text'] });
});

test('it accepts an image event', () => {
  const payload = {
    type: 'image',
    image: {
      id: 'img-1',
      name: 'base',
      ref: 'docker.io/library/alpine:3',
      digest: 'sha256:abc',
      source: 'oci',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      sizeBytes: 1_048_576,
      pinned: false,
    },
  } as const;

  expect(ImageOpEventSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('it rejects an image event with its date as a string', () => {
  const result = ImageOpEventSchema.safeParse({
    type: 'image',
    image: {
      id: 'img-1',
      name: 'base',
      ref: 'docker.io/library/alpine:3',
      digest: 'sha256:abc',
      source: 'oci',
      createdAt: '2026-01-02T03:04:05.000Z',
      sizeBytes: 1_048_576,
    },
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['image', 'createdAt'],
    code: 'invalid_type',
  });
});

test('it rejects an error event, which throws through the iterator instead', () => {
  const result = ImageOpEventSchema.safeParse({
    type: 'error',
    code: 'BUILD_FAILED',
    message: 'the build failed',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['type'], code: 'invalid_union' });
});

test('it rejects a phase outside the phase list', () => {
  const result = ImageOpEventSchema.safeParse({ type: 'progress', phase: 'push', elapsedMs: 1500 });

  expect(result.error?.issues).toPartiallyContain({ path: ['phase'], code: 'invalid_value' });
});

test('it rejects a negative elapsed time', () => {
  const result = ImageOpEventSchema.safeParse({ type: 'progress', phase: 'build', elapsedMs: -1 });

  expect(result.error?.issues).toPartiallyContain({ path: ['elapsedMs'], code: 'too_small' });
});
