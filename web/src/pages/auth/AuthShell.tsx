import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { brand } from '../../brand';
import { Footer } from '../../layout/AppLayout';

/** Estrutura das telas de acesso: painel da marca (logo oficial) e formulário em cartão. */
export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth-page">
      <aside className="auth-brand" aria-label="Venceu">
        <Link to="/" aria-label="Venceu — página inicial">
          <img src={brand.full.src} width={brand.full.width} height={brand.full.height} alt="Venceu — lembretes de vencimento com automação de chatbot" />
        </Link>
        <p>Avisos automáticos por WhatsApp e e-mail, assistente virtual e mais clientes em dia.</p>
      </aside>
      <div className="auth-main">
        <main className="auth-center">
          <div className="auth-card">
            <h1>{title}</h1>
            {children}
          </div>
        </main>
        <Footer className="auth-footer" />
      </div>
    </div>
  );
}

/** Lê o token do fragmento (#token=...) e o remove da barra de endereço. */
export function readHashToken(): string | null {
  const m = window.location.hash.match(/token=([A-Za-z0-9_-]+)/);
  if (m) window.history.replaceState(null, '', window.location.pathname);
  return m ? m[1]! : null;
}
