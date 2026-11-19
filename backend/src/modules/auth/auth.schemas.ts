import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email address')
  .max(320);

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

export const nameSchema = z.string().trim().min(1, 'Name is required').max(120);

const tokenSchema = z.string().min(20).max(200);

export const registerBody = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema,
});

export const loginBody = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(128),
});

export const verifyEmailBody = z.object({ token: tokenSchema });

export const forgotPasswordBody = z.object({ email: emailSchema });

export const resetPasswordBody = z.object({ token: tokenSchema, password: passwordSchema });

export const googleStartQuery = z.object({ redirect: z.string().max(512).optional() });

export const googleCallbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(200).optional(),
});

export const googleTokenBody = z.object({ credential: z.string().min(20).max(4096) });

export const sessionIdParams = z.object({ sessionId: z.string().uuid() });
