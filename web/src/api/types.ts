export type OrgRole = 'owner' | 'staff';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  orgId: string | null;
  orgName: string | null;
  role: OrgRole | null;
  isPlatformAdmin: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type ChargeStatus = 'aberta' | 'paga' | 'cancelada';
export type MessageStatus = 'pendente' | 'manual' | 'enviada' | 'falhou' | 'cancelada';
export type Channel = 'whatsapp' | 'email';
export type TemplateKind = 'lembrete' | 'vencimento' | 'atraso' | 'pagamento_confirmado' | 'personalizada';
export type WhatsAppMode = 'manual' | 'cloud_api' | 'webhook';

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  document: string | null;
  notes: string | null;
  whatsappOptIn: boolean;
  emailOptIn: boolean;
  isActive: boolean;
  createdAt: string;
  openCount: number;
  overdueCount: number;
  overdueCents: number;
  nextDueDate: string | null;
  planName?: string | null;
}

export interface Subscription {
  id: string;
  description: string;
  amountCents: number;
  intervalMonths: number;
  nextDueDate: string;
  billingDay?: number;
  status: 'ativa' | 'pausada' | 'cancelada';
  planId?: string | null;
  createdAt: string;
  customerId?: string;
  customerName?: string;
}

export interface Charge {
  id: string;
  description: string;
  amountCents: number;
  dueDate: string;
  status: ChargeStatus;
  paidAt: string | null;
  paidAmountCents: number | null;
  paymentMethod: string | null;
  paymentLink: string | null;
  reportedPaidAt: string | null;
  notes?: string | null;
  subscriptionId?: string | null;
  overdue: boolean;
  daysLate?: number;
  customerId?: string;
  customerName?: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
}

export interface Message {
  id: string;
  channel: Channel;
  kind: string;
  status: MessageStatus;
  toAddress?: string;
  subject?: string | null;
  body: string;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  customerId?: string | null;
  customerName?: string | null;
  chargeId?: string | null;
  waLink?: string | null;
}

export interface CustomerDetail extends Customer {
  subscriptions: Subscription[];
  charges: Charge[];
  messages: Message[];
  conversation: { id: string; status: string; unread: number } | null;
}

export interface Plan {
  id: string;
  name: string;
  description: string | null;
  amountCents: number;
  intervalMonths: number;
  isActive: boolean;
  activeSubscriptions: number;
}

export interface Template {
  id: string;
  kind: TemplateKind;
  name: string;
  subject: string | null;
  body: string;
  waTemplateName: string | null;
  waTemplateLang: string;
  rules: number;
}

export interface Rule {
  id: string;
  offsetDays: number;
  templateId: string;
  templateName: string;
  sendWhatsapp: boolean;
  sendEmail: boolean;
  isActive: boolean;
}

export interface BotAnswer {
  id: string;
  title: string;
  keywords: string[];
  answer: string;
  isActive: boolean;
}

export interface Conversation {
  id: string;
  phone: string;
  status: 'bot' | 'humano' | 'encerrada';
  unread: number;
  lastMessageAt: string;
  customerId: string | null;
  customerName: string | null;
  lastMessage?: string | null;
}

export interface ChatMessage {
  id: string;
  direction: 'in' | 'out';
  author: 'cliente' | 'bot' | 'atendente' | 'sistema';
  body: string;
  createdAt: string;
  userName: string | null;
}

export interface SendResult {
  messageId?: string;
  status: string;
  error: string | null;
  waLink: string | null;
}

export interface TeamUser {
  id: string;
  email: string;
  fullName: string;
  role: OrgRole;
  isActive: boolean;
  createdAt?: string;
  lastLoginAt: string | null;
  accessStatus: 'ativo' | 'convite_pendente' | 'convite_expirado' | 'desativado';
}

export interface InviteResult {
  id?: string;
  inviteLink?: string;
  inviteSent?: boolean;
  validHours?: number;
  resetLink?: string;
}
