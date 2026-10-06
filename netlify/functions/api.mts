// API do Venceu em Netlify Functions: mesmo servidor Fastify, mesmo domínio do site.
import { handleWebRequest } from '../../server/src/serverless.ts';

interface NetlifyContext {
  ip: string;
}

export default async (request: Request, context: NetlifyContext) => handleWebRequest(request, context.ip);

export const config = { path: '/api/*' };
