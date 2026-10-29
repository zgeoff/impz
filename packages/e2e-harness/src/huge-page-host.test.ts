import { expect, test } from 'bun:test';
import { buildHugePageSettings, parseHugetlbMib } from './huge-page-host';

test('#parseHugetlbMib reads the pool pages a process holds, in MiB', () => {
  const status = ['Name:\tfirecracker', 'VmRSS:\t   20480 kB', 'HugetlbPages:\t  139264 kB'].join(
    '\n',
  );

  expect(parseHugetlbMib(status)).toBe(136);
});

test('#parseHugetlbMib reads no pool pages from a status without the field', () => {
  expect(parseHugetlbMib('Name:\tfirecracker\nVmRSS:\t   20480 kB')).toBe(0);
});

test('#buildHugePageSettings turns huge pages on for a host with a pool', () => {
  expect(buildHugePageSettings(true)).toStrictEqual({ IMP_HUGE_PAGES: '2M' });
});

test('#buildHugePageSettings asks for no settings on a host without a pool', () => {
  expect(buildHugePageSettings(false)).toBeNull();
});
