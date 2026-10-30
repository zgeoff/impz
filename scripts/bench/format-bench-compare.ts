import { BenchReportSchema } from '@impz/cli/bench-report-schema';

export interface ArmReport {
  readonly arm: string;
  readonly json: string;
}

type Figure = 'p50' | 'p95' | 'p99';

const FIGURES: readonly Figure[] = ['p50', 'p95', 'p99'];

// Each arm ran its rounds in turn with the others on one machine, so a cell
// holds the lower median of that arm's rounds, a figure one round measured, and
// the change is against the first arm.
export function formatBenchCompare(reports: readonly ArmReport[]): string {
  const arms = [...new Set(reports.map((report) => report.arm))];
  const rows = collectRows(reports);
  const header = ['scenario', 'conc'];

  for (const figure of FIGURES) {
    header.push(...arms.map((arm) => `${arm} ${figure}`));
  }

  header.push(...arms.map((arm) => `${arm} failed`));

  const lines = rows.map((row) => {
    const line = [row.scenario, String(row.concurrency)];
    const reference = row.cells.get(arms[0] ?? '');

    for (const figure of FIGURES) {
      const base = pickLowerMedian(reference?.figures[figure] ?? []);

      line.push(
        ...arms.map((arm) => {
          const value = pickLowerMedian(row.cells.get(arm)?.figures[figure] ?? []);
          const against = arm === arms[0] ? null : base;

          return formatCell(value, against);
        }),
      );
    }

    line.push(...arms.map((arm) => String(row.cells.get(arm)?.failed ?? 0)));

    return line;
  });

  return [header, header.map(() => '---'), ...lines]
    .map((cells) => `| ${cells.join(' | ')} |`)
    .join('\n');
}

interface ArmCell {
  readonly figures: Readonly<Record<Figure, number[]>>;
  failed: number;
}

interface Row {
  readonly scenario: string;
  readonly concurrency: number;
  readonly cells: Map<string, ArmCell>;
}

function collectRows(reports: readonly ArmReport[]): Row[] {
  const rows = new Map<string, Row>();

  for (const report of reports) {
    const parsed = BenchReportSchema.parse(JSON.parse(report.json));

    for (const result of parsed.results) {
      const key = `${result.scenario}@${String(result.concurrency)}`;

      const row = rows.get(key) ?? {
        scenario: result.scenario,
        concurrency: result.concurrency,
        cells: new Map<string, ArmCell>(),
      };

      const cell = row.cells.get(report.arm) ?? {
        figures: { p50: [], p95: [], p99: [] },
        failed: 0,
      };

      const latency = result.latencyMs;

      if (latency !== null) {
        for (const figure of FIGURES) {
          cell.figures[figure].push(latency[figure]);
        }
      }

      cell.failed += Object.values(result.failures).reduce((sum, count) => sum + count, 0);

      row.cells.set(report.arm, cell);
      rows.set(key, row);
    }
  }

  return [...rows.values()];
}

function pickLowerMedian(values: readonly number[]): number | null {
  const sorted = values.toSorted((left, right) => left - right);

  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function formatCell(value: number | null, base: number | null): string {
  if (value === null) {
    return '-';
  }

  if (base === null || base === 0) {
    return `${String(value)}ms`;
  }

  const percent = Math.round(((value - base) / base) * 100);
  const change = percent > 0 ? `+${String(percent)}%` : `${String(percent)}%`;

  return `${String(value)}ms (${change})`;
}
