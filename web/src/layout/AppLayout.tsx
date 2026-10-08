import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import { fmtDate, roleLabel, initials } from '../lib/format';
import { Button } from '../components/ui';
import { Icon, type IconName } from '../components/icons';
import { brand } from '../brand';

export function Footer({ className = 'footer' }: { className?: string }) {
  return <footer className={className}>{brand.credit}</footer>;
}

/** Logotipo oficial (arquivos de imagem — nunca recriado com fonte parecida). */
export function BrandMark({ compact }: { compact?: boolean }) {
  return (
    <>
      <img src={brand.icon.src} width={brand.icon.width} height={brand.icon.height} alt="" className="brand-icon" decoding="async" />
      {!compact && (
        <img src={brand.wordmark.src} width={brand.wordmark.width} height={brand.wordmark.height} alt="Venceu" className="brand-word" decoding="async" />
      )}
    </>
  );
}

interface Counters {
  waitingConversations: number;
  manualQueue: number;
  toConfirm: number;
  planName: string | null;
  accessUntil: string | null;
  accessDaysLeft: number | null;
  graceDays: number;
  autoSuspend: boolean;
}

/** Aviso do plano do Venceu para a organização (vencendo ou vencido). */
function PlanBanner({ c }: { c: Counters }) {
  if (c.accessDaysLeft === null || c.accessDaysLeft > 5) return null;
  const late = c.accessDaysLeft < 0;
  const cutIn = c.graceDays + c.accessDaysLeft;
  return (
    <div className={`alert ${late ? 'alert-error' : 'alert-warning'}`} role="status" style={{ marginBottom: 16 }}>
      {late
        ? `Seu plano${c.planName ? ` ${c.planName}` : ''} venceu em ${fmtDate(c.accessUntil)}.${c.autoSuspend ? ` O acesso será suspenso ${cutIn > 0 ? `em ${cutIn} dia(s)` : 'em breve'} se o pagamento não for registrado.` : ''}`
        : `Seu plano${c.planName ? ` ${c.planName}` : ''} vence ${c.accessDaysLeft === 0 ? 'hoje' : `em ${c.accessDaysLeft} dia(s)`} (${fmtDate(c.accessUntil)}).`}
      {' '}Fale com o suporte do Venceu para renovar.
    </div>
  );
}

function Item({ to, icon, label, count, end }: { to: string; icon: IconName; label: string; count?: number; end?: boolean }) {
  return (
    <NavLink to={to} end={end}>
      <Icon name={icon} />
      {label}
      {!!count && (
        <span className="count" aria-label={`${count} pendente(s)`}>
          {count}
        </span>
      )}
    </NavLink>
  );
}

export function AppLayout() {
  const { user, isOwner, hasOrg, isPlatform, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  // Sair: volta para a tela de acesso sem "lembrar" a página atual (outra conta pode entrar em seguida).
  const signOut = async () => {
    await logout();
    nav('/entrar', { replace: true, state: null });
  };
  useEffect(() => setOpen(false), [loc.pathname]);
  const counters = useQuery({
    queryKey: ['counters'],
    queryFn: () => api.get<Counters>('/api/counters'),
    enabled: hasOrg,
    refetchInterval: 60_000,
  });
  const c = counters.data;

  return (
    <div className="app-shell">
      <a href="#conteudo" className="skip-link">
        Pular para o conteúdo
      </a>
      {open && <div className="backdrop" onClick={() => setOpen(false)} aria-hidden />}
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Menu principal">
        <NavLink to="/app" className="brand" aria-label="Venceu — painel">
          <BrandMark />
        </NavLink>
        {hasOrg && (
          <div className="org-chip">
            <strong title={user?.orgName ?? ''}>{user?.orgName}</strong>
            <span>{user?.role ? roleLabel[user.role] : ''}</span>
          </div>
        )}
        <nav className="nav" aria-label="Navegação principal">
          {hasOrg && (
            <>
              <Item to="/app" end icon="dashboard" label="Painel" />
              <Item to="/app/cobrancas" icon="receipt" label="Cobranças" count={c?.toConfirm} />
              <Item to="/app/clientes" icon="users" label="Clientes" />
              <Item to="/app/planos" icon="layers" label="Planos e assinaturas" />
              <div className="nav-section">Comunicação</div>
              <Item to="/app/lembretes" icon="checkCircle" label="Controle de envios" />
              <Item to="/app/atendimento" icon="chat" label="Atendimento" count={c?.waitingConversations} />
              <Item to="/app/mensagens" icon="send" label="Mensagens" count={c?.manualQueue} />
              <Item to="/app/automacao" icon="zap" label="Automação e assistente" />
              <div className="nav-section">Conta</div>
              <Item to="/app/configuracoes" icon="settings" label={isOwner ? 'Configurações' : 'Empresa'} />
              {isOwner && <Item to="/app/auditoria" icon="shield" label="Auditoria" />}
            </>
          )}
          {isPlatform && (
            <>
              <div className="nav-section">Plataforma Venceu</div>
              <Item to="/app/plataforma" end icon="building" label="Organizações" />
              <Item to="/app/plataforma/vendas" icon="dollar" label="Venda online" />
              <Item to="/app/plataforma/pedidos" icon="inbox" label="Pedidos de acesso" />
              <Item to="/app/plataforma/auditoria" icon="shield" label="Auditoria geral" />
            </>
          )}
          {!hasOrg && <div className="nav-section">Conta</div>}
          <Item to="/app/conta" icon="user" label="Minha conta" />
        </nav>
        <div className="sidebar-user">
          <span className="avatar" aria-hidden>
            {initials(user?.fullName ?? '')}
          </span>
          <div className="who">
            <strong>{user?.fullName}</strong>
            <span className="role">{isPlatform && !hasOrg ? 'Administração da plataforma' : user?.email}</span>
          </div>
          <Button size="sm" variant="ghost" className="btn-icon" onClick={() => void signOut()} aria-label="Sair" title="Sair">
            <Icon name="logout" />
          </Button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <NavLink to="/app" className="brand" aria-label="Venceu — painel">
            <BrandMark />
          </NavLink>
          <Button size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Abrir menu">
            <Icon name="menu" />
          </Button>
        </header>
        <main id="conteudo" className="content" tabIndex={-1}>
          {c && <PlanBanner c={c} />}
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  );
}
