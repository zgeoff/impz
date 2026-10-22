import { callerContract } from './caller-contract';
import { sessionContract } from './session-contract';

export const impContract = { ...callerContract, ...sessionContract };

export type ImpContract = typeof impContract;
