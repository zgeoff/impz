import { readFileSync, readdirSync } from 'node:fs';

// Linux lists each thread's children apart, and a child stays listed until its parent reaps it.
export function listChildPids(): number[] {
  const tasks = readdirSync('/proc/self/task');

  return tasks
    .flatMap((task) => readFileSync(`/proc/self/task/${task}/children`, 'utf8').split(' '))
    .filter((pid) => pid.trim() !== '')
    .map(Number)
    .toSorted((left, right) => left - right);
}
