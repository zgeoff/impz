import { writeFileSync } from 'node:fs';

interface StubTemplateWriterOptions {
  readonly contents: string;
  readonly pause?: { readonly partial: string; readonly release: Promise<void> };
  readonly failure?: Error;
}

export function buildStubTemplateWriter(options: StubTemplateWriterOptions) {
  const paths: string[] = [];
  const builds: readonly string[] = paths;

  return {
    builds,
    writeTemplate: async (path: string): Promise<void> => {
      paths.push(path);

      if (options.pause !== undefined) {
        writeFileSync(path, options.pause.partial);

        await options.pause.release;
      }

      writeFileSync(path, options.contents);

      if (options.failure !== undefined) {
        throw options.failure;
      }
    },
  };
}
