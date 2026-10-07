import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requireOrg, requireOwner } from '../../lib/context.js';
import { AppError, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zText, zUuid } from '../../lib/normalize.js';
import { MAX_MEDIA_BYTES, mediaUrl, safeFileName, sniffMime } from '../../lib/media.js';

const COLS = `id, name, mime, size_bytes as "sizeBytes", token, created_at as "createdAt"`;

export function registerMediaRoutes(app: FastifyInstance, deps: Deps) {
  const withUrl = <T extends { token: string; name: string }>(m: T) => ({ ...m, url: mediaUrl(deps.config.appUrl, m) });

  app.get('/api/media', async (req) => {
    requireOrg(req);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ token: string; name: string }>(`select ${COLS} from media_files order by created_at desc limit 200`);
      return { items: rows.map(withUrl) };
    });
  });

  /** Envio de arquivo em base64 (JSON). Limite de 4 MB; tipo detectado pelo conteúdo. */
  app.post('/api/media', { bodyLimit: 6 * 1024 * 1024 }, async (req, reply) => {
    const me = requireOrg(req);
    const body = parse(z.object({ name: zText(1, 120), data: z.string().min(16).max(6 * 1024 * 1024) }).strict(), req.body);
    await deps.limiters.sendNow.consume(`media:${me.id}`);
    const b64 = body.data.replace(/^data:[^;]+;base64,/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new AppError(422, 'invalid', 'Arquivo inválido.');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > MAX_MEDIA_BYTES) throw new AppError(413, 'too_large', 'Arquivo acima de 4 MB.');
    const mime = sniffMime(buf);
    if (!mime) {
      throw new AppError(415, 'unsupported', 'Formato não aceito. Use imagem JPG/PNG, áudio (OGG, MP3, M4A, AAC, AMR) ou PDF.');
    }
    const created = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ id: string; token: string; name: string }>(
        `insert into media_files (organization_id, name, mime, size_bytes, data, created_by)
         values ($1, $2, $3, $4, $5, app.uid()) returning ${COLS}`,
        [me.orgId, safeFileName(body.name), mime, buf.length, buf],
      );
      await audit(db, req, 'media.uploaded', 'media', rows[0]!.id, me.orgId, { mime, size: buf.length });
      return rows[0]!;
    });
    reply.code(201);
    return withUrl(created);
  });

  app.delete('/api/media/:id', async (req) => {
    const me = requireOwner(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await asUser(deps, req, async (db) => {
      const r = await db.query('delete from media_files where id = $1', [id]);
      if (!r.rowCount) throw notFound('Arquivo não encontrado.');
      await audit(db, req, 'media.deleted', 'media', id, me.orgId);
    });
    return { ok: true };
  });

  /**
   * Download público pelo identificador aleatório (o WhatsApp baixa o anexo
   * por este link). Sem listagem, sem dados da organização.
   */
  app.get('/api/media/:token/:name', { config: { public: true } }, async (req, reply) => {
    const p = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/), name: z.string().max(200) }).safeParse(req.params);
    if (!p.success) throw notFound();
    await deps.limiters.mediaIp.consume(`ip:${req.ip}`);
    const { rows } = await deps.pools.owner.query<{ name: string; mime: string; data: Buffer }>(
      `select m.name, m.mime, m.data from media_files m join organizations o on o.id = m.organization_id
        where m.token = $1 and o.is_active`,
      [p.data.token],
    );
    const m = rows[0];
    if (!m) throw notFound();
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Content-Disposition', `inline; filename="${safeFileName(m.name)}"`);
    reply.type(m.mime);
    return reply.send(m.data);
  });
}
