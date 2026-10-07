import dns from 'node:dns/promises';
import net from 'node:net';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { Config } from '../config.js';
import { isBlockedAddress, OutboundError } from './http.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  /** Cabeçalho List-Unsubscribe (descadastro em um clique pelos provedores de e-mail). */
  unsubscribeUrl?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/**
 * Caixa de saída em memória para desenvolvimento e testes.
 * Em homologação/produção é usada somente com MAIL_MODE=manual (nada é enviado).
 */
export class MemoryMailer implements Mailer {
  readonly outbox: MailMessage[] = [];
  async send(msg: MailMessage) {
    this.outbox.push(msg);
    if (process.env.APP_ENV === 'development') {
      // Somente em desenvolvimento: exibe no terminal para permitir testar convites localmente.
      // eslint-disable-next-line no-console
      console.info(`\n[dev-mail] Para: ${msg.to}\nAssunto: ${msg.subject}\n${msg.text}\n`);
    }
  }
}

export class SmtpMailer implements Mailer {
  private transport;
  constructor(options: string | SMTPTransport.Options, private readonly from: string) {
    this.transport = nodemailer.createTransport(options);
  }
  async send(msg: MailMessage) {
    await this.transport.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      ...(msg.unsubscribeUrl ? { list: { unsubscribe: msg.unsubscribeUrl } } : {}),
    });
  }
}

export function createMailer(config: Config): Mailer {
  if (config.SMTP_URL) return new SmtpMailer(config.SMTP_URL, config.mailFrom);
  if (config.SMTP_USER && config.SMTP_PASSWORD) {
    return new SmtpMailer(
      {
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_PORT === 465,
        // Senhas de aplicativo do Gmail são exibidas com espaços; o servidor espera sem.
        auth: { user: config.SMTP_USER.trim(), pass: config.SMTP_PASSWORD.replace(/\s+/g, '') },
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 15000,
      },
      config.mailFrom,
    );
  }
  return new MemoryMailer();
}

/** Conta de e-mail própria de uma organização. */
export interface OrgSmtp {
  host: string;
  port: number;
  user: string;
  password: string;
  fromName: string;
}

export type OrgMailerFactory = (smtp: OrgSmtp) => Mailer;

/** Nome de exibição seguro para o cabeçalho From (sem aspas, quebras ou sinais de endereço). */
export function fromHeader(name: string, address: string) {
  const clean = name.replace(/[\r\n"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean ? `"${clean}" <${address}>` : address;
}

/**
 * Envio pela conta da organização. O host é informado pelo cliente: resolve o
 * DNS a cada envio, recusa endereços internos (SSRF) e conecta direto no IP
 * verificado, validando o certificado pelo nome original.
 */
export class OrgSmtpMailer implements Mailer {
  constructor(private readonly smtp: OrgSmtp) {}
  async send(msg: MailMessage) {
    const { host, port, user, password, fromName } = this.smtp;
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new OutboundError('Servidor de e-mail não encontrado. Confira o endereço SMTP.');
    if (addrs.some((a) => isBlockedAddress(a.address))) throw new OutboundError('Servidor de e-mail não permitido.');
    const transport = nodemailer.createTransport({
      host: addrs[0]!.address,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      tls: { servername: host, minVersion: 'TLSv1.2' },
      auth: { user, pass: password.replace(/\s+/g, '') },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 15000,
    });
    try {
      await transport.sendMail({
        from: fromHeader(fromName, user),
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
        ...(msg.unsubscribeUrl ? { list: { unsubscribe: msg.unsubscribeUrl } } : {}),
      });
    } finally {
      transport.close();
    }
  }
}

export const createOrgMailer: OrgMailerFactory = (smtp) => new OrgSmtpMailer(smtp);
