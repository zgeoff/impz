import { Elysia } from 'elysia';
import { DASHBOARD_PATH, createDashboardFiles } from './dashboard/dashboard-files';

export function createDashboardRoutes(dashboardDir: string | null) {
  const dashboard = createDashboardFiles(dashboardDir);

  return new Elysia()
    .get('/', () => Response.redirect(DASHBOARD_PATH, 302))
    .get(DASHBOARD_PATH, (context) => dashboard.serve(context.request))
    .get(`${DASHBOARD_PATH}*`, (context) => dashboard.serve(context.request));
}
