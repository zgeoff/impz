import type { Args } from 'gunshi';
import { jsonArg } from '../args/common-args';
import { BENCH_SCENARIOS } from './bench-scenarios';

export const BENCH_ARGS = {
  scenarios: {
    type: 'positional',
    description: `scenarios, comma-separated: ${BENCH_SCENARIOS.map((scenario) => scenario.name).join(', ')} (default: create,wake,restore)`,
    required: false,
  },
  concurrency: {
    type: 'string',
    description: 'how many imps take the timed step at once, comma-separated',
    default: '1,4,16,64',
  },
  samples: {
    type: 'string',
    description: 'the fewest timed steps at each concurrency',
    default: '20',
  },
  memory: { type: 'string', description: "each imp's memory (default: the host's)" },
  image: { type: 'string', description: "each imp's image (default: the host's)" },
  awake: {
    type: 'string',
    description: 'how long an imp stays awake before a scenario puts it to sleep (30s, 2m)',
    default: '0',
  },
  label: { type: 'string', description: 'a name for this machine, kept with the results' },
  'limit-p50-ms': {
    type: 'string',
    description: 'fail when the median at any concurrency passes this many ms',
  },
  json: jsonArg,
} as const satisfies Args;
