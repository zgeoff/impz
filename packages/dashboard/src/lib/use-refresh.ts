import { useQueryClient } from '@tanstack/react-query';

// one action moves RAM, states and checkpoints at once, and every query is
// cheap, so a change refreshes every view
export function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();

  return () => queryClient.invalidateQueries();
}
