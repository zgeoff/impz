import * as z from 'zod';
import { NameSchema } from './name-schema';

export const NameInputSchema = z.object({ name: NameSchema });
