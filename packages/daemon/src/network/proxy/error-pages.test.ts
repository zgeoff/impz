import { expect, test } from 'bun:test';
import { buildErrorPage } from './error-pages';

test('it escapes the detail it shows, an apostrophe included', async () => {
  const page = buildErrorPage(502, `<b>can't</b> "connect" & retry`);

  const html = await page.text();

  expect(html).toInclude('<p>&lt;b&gt;can&#39;t&lt;/b&gt; &quot;connect&quot; &amp; retry</p>');
});

test('it titles the page for its status', async () => {
  const page = buildErrorPage(503, 'the imp did not wake in time');

  const html = await page.text();

  expect(page.status).toBe(503);
  expect(html).toInclude('<h1>503 The imp could not wake</h1>');
});
