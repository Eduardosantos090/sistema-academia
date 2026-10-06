import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Loading } from './components/ui';
import { AppLayout } from './layout/AppLayout';
import { LandingPage } from './pages/public/LandingPage';
import { UnsubscribePage } from './pages/public/UnsubscribePage';
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
import { InboxPage } from './pages/inbox/InboxPage';
import { AutomationPage } from './pages/automation/AutomationPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { OrgsPage } from './pages/platform/OrgsPage';
import { OrgPage } from './pages/platform/OrgPage';
import { RequestsPage } from './pages/platform/RequestsPage';
import { AuditPage } from './pages/AuditPage';
import { AccountPage } from './pages/AccountPage';
import { NotFoundPage } from './pages/NotFoundPage';

function RequireAuth({ children, org, owner, platform }: { children: ReactNode; org?: boolean; owner?: boolean; platform?: boolean }) {
  const { user, loading, hasOrg, isOwner, isPlatform } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/entrar" replace state={{ from: loc.pathname }} />;
  // Proteção de interface apenas; a autorização efetiva é feita no servidor e no banco (RLS).
  if ((org && !hasOrg) || (owner && !isOwner) || (platform && !isPlatform)) return <NotFoundPage />;
  return <>{children}</>;
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
        <Route path="atendimento" element={<RequireAuth org><InboxPage /></RequireAuth>} />
        <Route path="automacao" element={<RequireAuth org><AutomationPage /></RequireAuth>} />
        <Route path="configuracoes" element={<RequireAuth org><SettingsPage /></RequireAuth>} />
        <Route path="auditoria" element={<RequireAuth owner><AuditPage /></RequireAuth>} />
        <Route path="plataforma" element={<RequireAuth platform><OrgsPage /></RequireAuth>} />
        <Route path="plataforma/organizacoes/:id" element={<RequireAuth platform><OrgPage /></RequireAuth>} />
        <Route path="plataforma/pedidos" element={<RequireAuth platform><RequestsPage /></RequireAuth>} />
        <Route path="plataforma/auditoria" element={<RequireAuth platform><AuditPage /></RequireAuth>} />
        <Route path="conta" element={<AccountPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage standalone />} />
    </Routes>
  );
}
