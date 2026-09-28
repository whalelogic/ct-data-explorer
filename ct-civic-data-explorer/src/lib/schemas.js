/** Small zod schemas reused across routes. */
import { z } from 'zod';

export const idParams = z.object({ id: z.coerce.number().int().positive('Invalid id') });

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address'));

export const newPasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  // bcrypt only uses the first 72 bytes; reject longer input rather than silently truncating it.
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes');
