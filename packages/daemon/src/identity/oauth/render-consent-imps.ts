// The consent page's field for the imps a grant may reach; it holds no text from the request.
export function renderConsentImps(): string {
  return [
    '<label for="imps">Imps this client may reach</label>',
    '<input id="imps" name="imps" type="text" required autocomplete="off" spellcheck="false" placeholder="dev-*">',
    '<p>Imp names or name prefixes with a trailing *, split by spaces. Write * for every imp.</p>',
  ].join('\n');
}
