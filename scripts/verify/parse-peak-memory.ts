// VmHWM, the high-water mark of resident memory, from the text of /proc/<pid>/status, in MiB; null
// when the text has no such line.
export function parsePeakMemory(status: string): number | null {
  const found = /^VmHWM:\s+(?<kib>\d+) kB$/mu.exec(status);
  const kib = found?.groups?.['kib'];

  return kib === undefined ? null : Math.round(Number(kib) / 1024);
}
