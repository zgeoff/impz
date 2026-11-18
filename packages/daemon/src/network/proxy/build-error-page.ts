import { renderHTML } from '../../platform/http/render-html';

const STATUS_TITLES: Readonly<Record<number, string>> = {
  401: 'Sign in to this imp',
  404: 'No such imp',
  429: 'Too many requests',
  502: 'Nothing answers in the imp',
  503: 'The imp could not wake',
};

export function buildErrorPage(status: number, detail: string): Response {
  const title = STATUS_TITLES[status] ?? 'Proxy error';

  const page = renderHTML`<!doctype html>
<title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>${String(status)} ${title}</h1>
<p>${detail}</p>
</body>`;

  return new Response(page.html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
