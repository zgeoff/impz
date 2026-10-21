import type { ImpEvent } from '@impz/client';
import { watchEvents } from '@impz/client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { isUnauthorized } from './build-query-client';
import { useImpd } from './impd';

const RECONNECT_MS = 2000;

export function useImpdEvents(): void {
  const impd = useImpd();
  const queryClient = useQueryClient();

  useEffect(() => {
    const controller = new AbortController();

    const signal = controller.signal;

    const applyEvent = async (event: Readonly<ImpEvent>): Promise<void> => {
      // an exec in an imp's agent changes nothing the dashboard shows
      if ((event.ev === 'ImpAdded' && event.reason === 'snapshot') || event.ev === 'AgentExec') {
        return;
      }

      if (event.ev === 'CheckpointAdded' || event.ev === 'CheckpointRemoved') {
        await queryClient.invalidateQueries({ queryKey: impd.query.checkpoints.key() });

        return;
      }

      if (event.ev !== 'GovernorDecision') {
        await queryClient.invalidateQueries({ queryKey: impd.query.imps.key() });
      }

      await queryClient.invalidateQueries({ queryKey: impd.query.system.key() });
    };

    const watchUntilUnmounted = async (): Promise<void> => {
      try {
        await watchEvents(impd.client, {
          signal,
          reconnect: { delayMs: RECONNECT_MS, shouldRetry: (error) => !isUnauthorized(error) },
          onOpen: async (attempt) => {
            // impd sends an event only to the streams open at the time
            if (attempt > 1) {
              await queryClient.invalidateQueries();
            }
          },
          onEvent: applyEvent,
        });
      } catch {
        // the queries' own 401 sends the browser to the login page
      }
    };

    void watchUntilUnmounted();

    return () => {
      controller.abort();
    };
  }, [impd, queryClient]);
}
