import * as z from 'zod';

// a TCP port in the guest
export const PortSchema = z.int().min(1).max(65_535);
