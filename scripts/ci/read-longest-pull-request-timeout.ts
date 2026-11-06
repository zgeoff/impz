import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';

const JobSchema = z.looseObject({ 'timeout-minutes': z.number().optional() });

const WorkflowSchema = z.looseObject({
  on: z.unknown(),
  jobs: z.record(z.string(), JobSchema),
});

export function readLongestPullRequestTimeout(directory: string): number {
  const timeouts = readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => readFileSync(join(directory, name), 'utf8'))
    .map((text) => WorkflowSchema.parse(Bun.YAML.parse(text)))
    .filter((workflow) => isPullRequestTrigger(workflow.on))
    .flatMap((workflow) => Object.values(workflow.jobs))
    .map((job) => job['timeout-minutes'] ?? 0);

  return Math.max(0, ...timeouts);
}

function isPullRequestTrigger(on: unknown): boolean {
  if (typeof on === 'string') {
    return on === 'pull_request';
  }

  if (Array.isArray(on)) {
    return on.includes('pull_request');
  }

  return typeof on === 'object' && on !== null && 'pull_request' in on;
}
