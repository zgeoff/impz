import { expect, test } from 'bun:test';
import { renderConsentImps } from './render-consent-imps';

test('#renderConsentImps renders a required field named imps', () => {
  expect(renderConsentImps()).toInclude('<input id="imps" name="imps" type="text" required');
});
