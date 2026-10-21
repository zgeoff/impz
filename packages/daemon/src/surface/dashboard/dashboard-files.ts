import { statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const DASHBOARD_PATH = '/ui/';

export function createDashboardFiles(directory: string | null) {
  const root = directory === null ? null : resolve(directory);

  return {
    serve: (request: Request): Response => {
      if (root === null || !probeFile(join(root, 'index.html'))) {
        return new Response('the dashboard is not built into this impd (IMP_DASHBOARD_DIR)\n', {
          status: 404,
        });
      }

      const path = decodePath(new URL(request.url).pathname.slice(DASHBOARD_PATH.length - 1));

      if (path === null) {
        return new Response('bad path\n', { status: 400 });
      }

      const file = resolve(root, `.${path}`);

      if (relative(root, file).startsWith('..') || !`${file}${sep}`.startsWith(`${root}${sep}`)) {
        return new Response('bad path\n', { status: 400 });
      }

      if (probeFile(file)) {
        return readFileResponse(file, path.startsWith('/assets/'));
      }

      // A stale chunk 404s instead of loading the shell's HTML as a script.
      if (path.startsWith('/assets/')) {
        return new Response('not found\n', { status: 404 });
      }

      return readFileResponse(join(root, 'index.html'), false);
    },
  };
}

// Vite names every asset by its content hash, so an asset never changes; the
// shell and anything else must be checked each time, or a new build is not seen.
function readFileResponse(file: string, immutable: boolean): Response {
  const headers: Record<string, string> = {
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  };

  if (file.endsWith('.html')) {
    Object.assign(headers, HTML_HEADERS);
  }

  return new Response(Bun.file(file), { headers });
}

// The page talks only to impd, and imps' pages on other ports of this host
// must not frame it.
const HTML_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",

    // xterm.js and the UI kit set inline styles.
    "style-src 'self' 'unsafe-inline'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'referrer-policy': 'same-origin',
};

function decodePath(pathname: string): string | null {
  try {
    const path = decodeURIComponent(pathname);

    if (path.includes('\0') || path.split(/[/\\]/u).includes('..')) {
      return null;
    }

    return path;
  } catch {
    return null;
  }
}

function probeFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
