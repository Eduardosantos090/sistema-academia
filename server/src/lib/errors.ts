export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (msg = 'Registro não encontrado.') => new AppError(404, 'not_found', msg);
export const forbidden = (msg = 'Você não tem permissão para esta operação.') =>
  new AppError(403, 'forbidden', msg);
export const conflict = (msg: string) => new AppError(409, 'conflict', msg);
export const badRequest = (msg: string) => new AppError(400, 'bad_request', msg);
export const unauthorized = (msg = 'Sessão expirada ou inválida. Entre novamente.') =>
  new AppError(401, 'unauthorized', msg);
export const tooMany = () =>
  new AppError(429, 'rate_limited', 'Muitas tentativas. Aguarde alguns minutos e tente novamente.');

export const staleVersion = () =>
  conflict('Este registro foi alterado por outra pessoa. Recarregue para ver a versão atual.');

interface PgLikeError {
  code?: string;
  message?: string;
}

/** Converte erros do PostgreSQL em respostas seguras (sem detalhes internos). */
export function fromPgError(err: unknown): AppError | null {
  const e = err as PgLikeError;
  if (!e || typeof e.code !== 'string') return null;
  switch (e.code) {
    case 'VC403':
      return new AppError(403, 'forbidden', e.message ?? 'Operação não permitida.');
    case 'VC409':
      return new AppError(409, 'conflict', e.message ?? 'Conflito.');
    case 'VC422':
      return new AppError(422, 'invalid', e.message ?? 'Dados inválidos.');
    case '42501': // violação de RLS / privilégio
      return forbidden();
    case '23505':
      return conflict('Já existe um registro com estes dados.');
    case '23503':
      return new AppError(409, 'conflict', 'Operação conflita com registros relacionados.');
    case '23514':
    case '22P02':
    case '22001':
      return new AppError(422, 'invalid', 'Dados inválidos.');
    default:
      return null;
  }
}
