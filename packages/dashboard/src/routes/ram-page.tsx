import type { Imp } from '@impz/client';
import { formatMib } from '@impz/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ErrorText } from '../error-text/error-text';
import { useImpd } from '../impd/impd';
import { LIVE } from '../impd/live';
import { StateBadge } from '../imps/state-badge';
import { RamMeter } from '../ram/ram-meter';
import tableStyles from '../table/table.module.css';
import styles from './page.module.css';

export function RamPage() {
  const impd = useImpd();
  const info = useQuery({ ...impd.query.system.info.queryOptions(), ...LIVE });
  const imps = useQuery({ ...impd.query.imps.list.queryOptions(), ...LIVE });
  const awake = sortByRam(imps.data ?? []);

  return (
    <div className={styles['page']}>
      <header className={styles['header']}>
        <h1>RAM</h1>
      </header>
      <ErrorText error={info.error ?? imps.error} />
      {info.data !== undefined && (
        <section className={styles['card']}>
          <RamMeter info={info.data} />
        </section>
      )}
      <table className={tableStyles['table']}>
        <thead>
          <tr>
            <th>Imp</th>
            <th>State</th>
            <th className={tableStyles['numeric']}>Owned</th>
            <th className={tableStyles['numeric']}>Resident</th>
            <th className={tableStyles['numeric']}>Memory</th>
          </tr>
        </thead>
        <tbody>
          {awake.map((imp) => (
            <tr key={imp.id}>
              <td>
                <Link to="/imps/$name" params={{ name: imp.name }}>
                  {imp.name}
                </Link>
              </td>
              <td>
                <StateBadge state={imp.state} />
              </td>
              <td className={tableStyles['numeric']}>{formatOptionalMib(imp.ramMib)}</td>
              <td className={tableStyles['numeric']}>{formatOptionalMib(imp.rssMib)}</td>
              <td className={tableStyles['numeric']}>{formatMib(imp.memoryMib)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function sortByRam(imps: readonly Imp[]): Imp[] {
  return imps.toSorted((first, second) => (second.ramMib ?? -1) - (first.ramMib ?? -1));
}

function formatOptionalMib(mib: number | undefined): string {
  return mib === undefined ? '—' : formatMib(mib);
}
