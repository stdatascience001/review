import type { UserRole } from '@prisma/client';

declare global {
  namespace Express {
    interface AuthContext {
      userId: string;
      sessionId: string;
      role: UserRole;
      email: string;
      emailVerified: boolean;
    }

    interface Request {
      auth?: AuthContext;
      /** Values parsed by the `validate` middleware (Express 5 makes req.query read-only). */
      valid: {
        body?: any;
        query?: any;
        params?: any;
      };
    }
  }
}

export {};
