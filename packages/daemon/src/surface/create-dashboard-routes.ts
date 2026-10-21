import { Elysia } from 'elysia';
import { createSessionRoutes } from './auth/session-routes';
import type { SessionRouteDeps } from './auth/session-routes';
import { DASHBOARD_PATH, createDashboardFiles } from './dashboard/dashboard-files';

interface DashboardRouteDeps extends SessionRouteDeps {
  readonly dashboardDir: string | null;
}

export function createDashboardRoutes(deps: DashboardRouteDeps) {
  const sessionRoutes = createSessionRoutes(deps);
  const dashboard = createDashboardFiles(deps.dashboardDir);

  return new Elysia()
    .post('/auth/login', (context) => sessionRoutes.login(context.request), { parse: 'none' })
    .post('/auth/logout', (context) => sessionRoutes.logout(context.request), { parse: 'none' })

    .get('/', () => Response.redirect(DASHBOARD_PATH, 302))
    .get(DASHBOARD_PATH, (context) => dashboard.serve(context.request))
    .get(`${DASHBOARD_PATH}*`, (context) => dashboard.serve(context.request));
}
