import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { Config } from '../config.js';

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
