import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Loading } from './components/ui';
import { AppLayout } from './layout/AppLayout';
import { LandingPage } from './pages/public/LandingPage';
import { UnsubscribePage } from './pages/public/UnsubscribePage';
import { PayPage } from './pages/public/PayPage';
import { SignupDonePage, SignupPage } from './pages/public/SignupPage';
import { PrivacyPage, TermsPage } from './pages/public/LegalPage';
import { LoginPage } from './pages/auth/LoginPage';
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage';
import { AcceptInvitePage } from './pages/auth/AcceptInvitePage';
import { DashboardPage } from './pages/DashboardPage';
import { CustomerListPage } from './pages/customers/CustomerListPage';
import { CustomerPage } from './pages/customers/CustomerPage';
import { ChargesPage } from './pages/charges/ChargesPage';
import { PlansPage } from './pages/plans/PlansPage';
import { MessagesPage } from './pages/messages/MessagesPage';
import { RemindersPage } from './pages/reminders/RemindersPage';
import { InboxPage } from './pages/inbox/InboxPage';
import { AutomationPage } from './pages/automation/AutomationPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { OrgsPage } from './pages/platform/OrgsPage';
import { OrgPage } from './pages/platform/OrgPage';
import { RequestsPage } from './pages/platform/RequestsPage';
import { SalesPage } from './pages/platform/SalesPage';
import { AuditPage } from './pages/AuditPage';
import { AccountPage } from './pages/AccountPage';

function RequireAuth({ children, org, owner, platform }: { children: ReactNode; org?: boolean; owner?: boolean; platform?: boolean }) {
  const { user, loading, hasOrg, isOwner, isPlatform } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/entrar" replace state={{ from: loc.pathname }} />;
  // Proteção de interface apenas; a autorização efetiva é feita no servidor e no banco (RLS).
  // Página de outro perfil (ex.: tela da plataforma aberta antes de trocar de conta): vai para o painel certo.
  if ((org && !hasOrg) || (owner && !isOwner) || (platform && !isPlatform)) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

/**
 * Endereço desconhecido: nunca mostra erro. Corrige links com prefixo extra
 * (ex.: /algo/convite#token=...) e atalhos comuns; o resto vai para o painel
 * (logado) ou para a página inicial.
 */
function UnknownRoute() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  const path = loc.pathname.toLowerCase().replace(/\/+$/, '');
  for (const known of ['/convite', '/redefinir-senha', '/descadastrar', '/esqueci-senha', '/entrar']) {
    if (path.endsWith(known)) return <Navigate to={`${known}${loc.hash}`} replace />;
  }
  if (/^\/(login|signin|acessar|admin|painel|dashboard)$/.test(path)) return <Navigate to={user ? '/app' : '/entrar'} replace />;
  return <Navigate to={user ? '/app' : '/'} replace />;
}

function Home() {
  const { hasOrg, isPlatform } = useAuth();
  if (!hasOrg && isPlatform) return <Navigate to="/app/plataforma" replace />;
  return <DashboardPage />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/entrar" element={<LoginPage />} />
      <Route path="/esqueci-senha" element={<ForgotPasswordPage />} />
      <Route path="/redefinir-senha" element={<ResetPasswordPage />} />
      <Route path="/convite" element={<AcceptInvitePage />} />
      <Route path="/descadastrar" element={<UnsubscribePage />} />
      <Route path="/pagar/:token" element={<PayPage />} />
      <Route path="/assinar" element={<SignupPage />} />
      <Route path="/termos" element={<TermsPage />} />
      <Route path="/privacidade" element={<PrivacyPage />} />
      <Route path="/assinar/concluido" element={<SignupDonePage />} />
      <Route
        path="/app"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Home />} />
        <Route path="clientes" element={<RequireAuth org><CustomerListPage /></RequireAuth>} />
        <Route path="clientes/:id" element={<RequireAuth org><CustomerPage /></RequireAuth>} />
        <Route path="cobrancas" element={<RequireAuth org><ChargesPage /></RequireAuth>} />
        <Route path="planos" element={<RequireAuth org><PlansPage /></RequireAuth>} />
        <Route path="mensagens" element={<RequireAuth org><MessagesPage /></RequireAuth>} />
        <Route path="lembretes" element={<RequireAuth org><RemindersPage /></RequireAuth>} />
        <Route path="atendimento" element={<RequireAuth org><InboxPage /></RequireAuth>} />
        <Route path="automacao" element={<RequireAuth org><AutomationPage /></RequireAuth>} />
        <Route path="configuracoes" element={<RequireAuth org><SettingsPage /></RequireAuth>} />
        <Route path="auditoria" element={<RequireAuth owner><AuditPage /></RequireAuth>} />
        <Route path="plataforma" element={<RequireAuth platform><OrgsPage /></RequireAuth>} />
        <Route path="plataforma/organizacoes/:id" element={<RequireAuth platform><OrgPage /></RequireAuth>} />
        <Route path="plataforma/vendas" element={<RequireAuth platform><SalesPage /></RequireAuth>} />
        <Route path="plataforma/pedidos" element={<RequireAuth platform><RequestsPage /></RequireAuth>} />
        <Route path="plataforma/auditoria" element={<RequireAuth platform><AuditPage /></RequireAuth>} />
        <Route path="conta" element={<AccountPage />} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Route>
      <Route path="*" element={<UnknownRoute />} />
    </Routes>
  );
}
