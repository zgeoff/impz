import type { Imp } from '@impz/client';
import { formatBytes, formatMib } from '@impz/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '../button/button';
import { CheckpointsPanel } from '../checkpoints/checkpoints-panel';
import { CpuPanel } from '../cpu/cpu-panel';
import { ErrorText } from '../error-text/error-text';
import { formatDiskUse, formatRelativeTime } from '../imp-details/format-relative-time';
import { useNow } from '../imp-details/use-now';
import { useImpd } from '../impd/impd';
import { LIVE, SLOW } from '../impd/live';
import { ForkDialog } from '../imps/fork-dialog';
import { ImpActions } from '../imps/imp-actions';
import { ImpNotes } from '../imps/imp-notes';
import { StateBadge } from '../imps/state-badge';
import styles from './page.module.css';

interface ImpPageProps {
  readonly name: string;
}

export function ImpPage(props: ImpPageProps) {
  const impd = useImpd();
  const nowMs = useNow();
  const [forking, setForking] = useState(false);

  const imp = useQuery({
    ...impd.query.imps.get.queryOptions({ input: { name: props.name } }),
    ...LIVE,
  });

  if (imp.data === undefined) {
    return (
      <div className={styles['page']}>
        <Link to="/">All imps</Link>
        {imp.isPending && <p className={styles['empty']}>Loading…</p>}
        <ErrorText error={imp.error} />
      </div>
    );
  }

  return (
    <div className={styles['page']}>
      <header className={styles['header']}>
        <h1>{imp.data.name}</h1>
        <StateBadge state={imp.data.state} />
        <div>
          <Button
            onClick={() => {
              setForking(true);
            }}
          >
            Fork
          </Button>
        </div>
      </header>
      <ImpActions imp={imp.data} afterDestroy="/" />
      <ImpNotes imp={imp.data} nowMs={nowMs} />
      <section className={styles['card']}>
        <ImpDetails imp={imp.data} nowMs={nowMs} />
      </section>
      <section className={styles['card']}>
        <CpuPanel imp={imp.data} />
      </section>
      <CheckpointsPanel name={props.name} nowMs={nowMs} />
      <ForkDialog open={forking} onOpenChange={setForking} source={props.name} />
    </div>
  );
}

interface ImpDetailsProps {
  readonly imp: Imp;
  readonly nowMs: number;
}

function ImpDetails(props: ImpDetailsProps) {
  const impd = useImpd();
  const imp = props.imp;

  const urls = useQuery({
    ...impd.query.imps.url.queryOptions({ input: { name: imp.name } }),
    ...SLOW,
  });

  return (
    <dl className={styles['details']}>
      <dt>Image</dt>
      <dd>{imp.image}</dd>
      <dt>Size</dt>
      <dd>
        {imp.vcpus} vCPU, {formatMib(imp.memoryMib)}
      </dd>
      <dt>RAM now</dt>
      <dd>
        {imp.ramMib === undefined ? 'not awake' : `${formatMib(imp.ramMib)} owned`}
        {imp.rssMib !== undefined && `, ${formatMib(imp.rssMib)} resident`}
      </dd>
      <dt>Disk</dt>
      <dd>
        {formatDiskUse(imp)}
        {imp.diskUsage !== undefined && `, ${formatBytes(imp.diskUsage.sharedBytes)} shared`}
      </dd>
      <dt>URL</dt>
      <dd>
        {urls.data?.https !== undefined && urls.data.https !== null && (
          <>
            <a href={urls.data.https} target="_blank" rel="noreferrer">
              {urls.data.https}
            </a>
            {' · '}
          </>
        )}
        <a href={imp.url} target="_blank" rel="noreferrer">
          {imp.url}
        </a>
        {urls.data?.tailnet !== undefined && urls.data.tailnet !== null && (
          <>
            {' · '}
            <a href={urls.data.tailnet} target="_blank" rel="noreferrer">
              {urls.data.tailnet}
            </a>
          </>
        )}
      </dd>
      <dt>Address</dt>
      <dd>
        <code>{imp.ip}</code>, HTTP port {imp.httpPort}
      </dd>
      <dt>Created</dt>
      <dd>{formatRelativeTime(imp.createdAt, props.nowMs)}</dd>
      <dt>Last active</dt>
      <dd>{formatRelativeTime(imp.lastActiveAt, props.nowMs)}</dd>
      {imp.sleptAt !== undefined && (
        <>
          <dt>Asleep since</dt>
          <dd>{formatRelativeTime(imp.sleptAt, props.nowMs)}</dd>
        </>
      )}
    </dl>
  );
}
