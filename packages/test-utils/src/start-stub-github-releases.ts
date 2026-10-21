import { onTestFinished } from 'bun:test';

interface StubGithubReleasesOptions {
  // null stands for a repo with no release, whose /latest GitHub redirects to
  // the releases page
  readonly latest: string | null;
  readonly assets: Readonly<Record<string, string>>;
}

export interface StubGithubReleases {
  readonly url: string;
  readonly requests: readonly string[];
}

export function startStubGithubReleases(options: StubGithubReleasesOptions): StubGithubReleases {
  const requests: string[] = [];

  const handleRequest = (request: Request) => {
    const path = new URL(request.url).pathname;

    requests.push(path);

    if (path === '/latest') {
      const location = options.latest === null ? '/' : `/tag/${options.latest}`;

      return Response.redirect(location, 302);
    }

    if (path.startsWith('/tag/') || path === '/') {
      return new Response('release page');
    }

    const asset = path.startsWith('/download/')
      ? options.assets[path.slice('/download/'.length)]
      : undefined;

    return asset === undefined ? new Response('Not Found', { status: 404 }) : new Response(asset);
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: handleRequest,
  });

  onTestFinished(() => server.stop(true));

  return { url: `http://127.0.0.1:${String(server.port)}`, requests };
}
