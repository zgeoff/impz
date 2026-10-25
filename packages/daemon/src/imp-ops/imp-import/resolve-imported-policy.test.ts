import { expect, mock, test } from 'bun:test';
import { resolveImportedPolicy } from './resolve-imported-policy';

test('it keeps a policy this impd reads', () => {
  const onUnknown = mock<(mode: string) => void>();
  const policy = resolveImportedPolicy({ mode: 'box', allow: ['github.com'], onUnknown });

  expect(policy).toStrictEqual({ mode: 'box', allow: ['github.com'] });
  expect(onUnknown).not.toHaveBeenCalled();
});

test('it lands a policy this impd cannot read as none and reports its mode', () => {
  const onUnknown = mock<(mode: string) => void>();
  const policy = resolveImportedPolicy({ mode: 'tunnel', allow: [], onUnknown });

  expect(policy).toStrictEqual({ mode: 'none', allow: [] });
  expect(onUnknown).toHaveBeenCalledExactlyOnceWith('tunnel');
});
