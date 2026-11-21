// As `date '+%Y-%m-%d %H:%M:%S'` prints the local time, the form dmesg --since reads.
export function formatLocalTimestamp(date: Date): string {
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((value) =>
    formatTwoDigits(value),
  );

  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) =>
    formatTwoDigits(value),
  );

  return `${day.join('-')} ${time.join(':')}`;
}

function formatTwoDigits(value: number): string {
  return String(value).padStart(2, '0');
}
