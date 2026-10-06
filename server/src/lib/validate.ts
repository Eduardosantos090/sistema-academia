import type { z } from 'zod';
import { AppError } from './errors.js';

export class ValidationError extends AppError {
  constructor(
    message: string,
    public readonly fields: Record<string, string>,
  ) {
    super(422, 'invalid', message);
  }
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.code === 'unrecognized_keys' ? 'Campo não permitido.' : issue.message;
  }
  const first = Object.values(fields)[0] ?? 'Dados inválidos.';
  throw new ValidationError(first.startsWith('Invalid') ? 'Dados inválidos.' : first, fields);
}
