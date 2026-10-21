import * as z from 'zod';

// No segment starts with a dot, so no path names a file the guest agent
// stages. The guest agent checks the same rule.
export const FILE_SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;

// The guest agent holds the same cap.
export const FILE_DATA_MAX_BYTES = 524_288;
export const FILES_GUEST_DIR = '/run/imp/files';
const FILE_PATH_MAX_SEGMENTS = 8;
const FILE_PATH_MAX_LENGTH = 512;

export const FilePathSchema = z
  .string()
  .min(1)
  .max(FILE_PATH_MAX_LENGTH)
  .refine(
    (path) => {
      const segments = path.split('/');

      return (
        segments.length <= FILE_PATH_MAX_SEGMENTS &&
        segments.every((segment) => FILE_SEGMENT_PATTERN.test(segment))
      );
    },
    {
      message: `must be 1 to ${FILE_PATH_MAX_SEGMENTS} segments joined by /, each a letter, digit or _ followed by up to 127 letters, digits, ., _ or -`,
    },
  );

export const FileContentSchema = z
  .string()
  .refine((content) => new TextEncoder().encode(content).byteLength <= FILE_DATA_MAX_BYTES, {
    message: `must be at most ${FILE_DATA_MAX_BYTES} bytes as UTF-8`,
  });
