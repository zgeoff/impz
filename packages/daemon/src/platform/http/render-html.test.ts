import { expect, test } from 'bun:test';
import { renderHTML } from './render-html';

test('it escapes every character that can end a text node or an attribute value', () => {
  const name = `<b class="x">it's & more</b>`;

  expect(renderHTML`<p title="${name}">${name}</p>`.html).toBe(
    '<p title="&lt;b class=&quot;x&quot;&gt;it&#39;s &amp; more&lt;/b&gt;">&lt;b class=&quot;x&quot;&gt;it&#39;s &amp; more&lt;/b&gt;</p>',
  );
});

test('it keeps markup it rendered as markup inside another render', () => {
  const inner = renderHTML`<strong>${'a & b'}</strong>`;

  expect(renderHTML`<p>${inner}</p>`.html).toBe('<p><strong>a &amp; b</strong></p>');
});

test('it joins a list of rendered markup in order', () => {
  const items = ['one', '<two>'].map((item) => renderHTML`<li>${item}</li>`);

  expect(renderHTML`<ul>${items}</ul>`.html).toBe('<ul><li>one</li><li>&lt;two&gt;</li></ul>');
});

test('it renders a template with no values as its text', () => {
  expect(renderHTML`<hr>`.html).toBe('<hr>');
});
