import { runRequireGate } from './run-require-gate.ts';

process.exitCode = await runRequireGate(process.env);
