import { defineRig } from '@zgeoff/rig';

// scripts/test-e2e.sh and scripts/zfs-host-test.sh run the e2e and zfs journeys on a dev instance,
// so rig never runs those two lanes; their limits are the ones the lint rules hold the files to.
export default defineRig({
  // the dashboard's component tests need a DOM, so test:dashboard runs them from its own package
  ignore: ['packages/dashboard/**'],
  lanes: {
    e2e: { limit: '60s' },
    zfs: { limit: '60s' },
    headscale: { limit: '15s', start: 'scripts/dev/prepare-docker-lane.ts' },
    pebble: { limit: '5s', start: 'scripts/dev/prepare-docker-lane.ts' },
    'small-fs': { limit: '15s' },
  },
});
