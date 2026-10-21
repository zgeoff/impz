import { authContract } from './auth-contract';

// every procedure that impd answers with no caller
export const sessionContract = { auth: authContract };
