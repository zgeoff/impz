import { registerRunHooks } from './register-run-hooks';

// The end-to-end suites reach real registries, which an MSW server would refuse.
registerRunHooks();
