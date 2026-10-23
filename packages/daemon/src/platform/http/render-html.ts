import { P, match } from 'ts-pattern';

const MARKUP: unique symbol = Symbol('markup');

export interface Markup {
  readonly [MARKUP]: true;
  readonly html: string;
}

type MarkupPart = string | Markup | readonly Markup[];

export function renderHTML(strings: TemplateStringsArray, ...parts: readonly MarkupPart[]): Markup {
  const html = parts.reduce<string>(
    (text, part, index) => `${text}${toHTML(part)}${strings[index + 1] ?? ''}`,
    strings[0] ?? '',
  );

  return { [MARKUP]: true, html };
}

function toHTML(part: MarkupPart): string {
  return match(part)
    .with(P.string, (text) => escapeHTML(text))
    .with(P.array(), (list) => list.map((each) => each.html).join(''))
    .with({ html: P.string }, (markup) => markup.html)
    .exhaustive();
}

function escapeHTML(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
