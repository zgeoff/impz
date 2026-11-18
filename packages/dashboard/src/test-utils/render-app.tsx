import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { buildRouter } from '../build-router';
import { buildQueryClient } from '../impd/build-query-client';
import { ImpdProvider, buildBrowserImpd } from '../impd/impd';
import { IMPD_ORIGIN } from './impd-origin';

export function renderApp(path = '/') {
  const router = buildRouter(createMemoryHistory({ initialEntries: [`/ui${path}`] }));

  const queryClient = buildQueryClient(() => {
    void router.navigate({ to: '/login' });
  });

  const rendered = render(
    <ImpdProvider impd={buildBrowserImpd(IMPD_ORIGIN)}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ImpdProvider>,
  );

  return { ...rendered, router, queryClient };
}
