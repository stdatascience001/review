import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validates and coerces request input. Parsed values are written to `req.valid`
 * (and to `req.body`); unknown body keys are stripped by zod's default behaviour.
 * ZodErrors are turned into 400 responses by the error handler.
 */
export const validate =
  (schemas: Schemas) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    req.valid ??= {};
    if (schemas.params) req.valid.params = schemas.params.parse(req.params);
    if (schemas.query) req.valid.query = schemas.query.parse(req.query);
    if (schemas.body) {
      req.valid.body = schemas.body.parse(req.body ?? {});
      req.body = req.valid.body;
    }
    next();
  };

/** Typed accessors for controllers. */
export const bodyOf = <S extends ZodTypeAny>(req: Request, _schema: S): z.infer<S> => req.valid.body;
export const queryOf = <S extends ZodTypeAny>(req: Request, _schema: S): z.infer<S> => req.valid.query;
export const paramsOf = <S extends ZodTypeAny>(req: Request, _schema: S): z.infer<S> => req.valid.params;
