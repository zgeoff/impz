import * as z from 'zod';

export const PortSchema = z.int().min(1).max(65_535);
