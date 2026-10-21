export interface StubGuestResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface StubGuestOptions {
  readonly proxyPort: number;
  readonly caFile: string;
  readonly address: string;
}

export function buildStubBrokerGuest(options: Readonly<StubGuestOptions>) {
  return {
    curl: async (url: string, extra: readonly string[] = []): Promise<StubGuestResult> => {
      const child = Bun.spawn(
        [
          'curl',
          '-sS',
          '--max-time',
          '10',
          '--interface',
          options.address,
          '--proxy',
          `http://127.0.0.1:${String(options.proxyPort)}`,
          '--cacert',
          options.caFile,
          ...extra,
          url,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );

      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      return { code, stdout, stderr };
    },
  };
}
