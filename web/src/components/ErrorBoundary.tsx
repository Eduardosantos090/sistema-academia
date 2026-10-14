import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Envia o erro ao servidor (sem dados de formulário) para diagnóstico. */
export function reportClientError(error: unknown, extra?: string) {
  try {
    const e = error instanceof Error ? error : new Error(String(error));
    const body = JSON.stringify({
      message: `${e.name}: ${e.message}`.slice(0, 2000),
      stack: `${e.stack ?? ''}${extra ? `\n--\n${extra}` : ''}`.slice(0, 20000),
      path: window.location.pathname,
      release: document.querySelector('script[type="module"][src]')?.getAttribute('src')?.slice(-40) ?? undefined,
    });
    void fetch('/api/client-errors', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true, credentials: 'same-origin' }).catch(() => undefined);
  } catch {
    /* nunca falha por causa do relato */
  }
}

/** Erro ao carregar um arquivo do site depois de uma atualização (versão antiga aberta no navegador). */
const isStaleBundle = (e: unknown) =>
  e instanceof Error && /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|error loading dynamically imported module/i.test(e.message);

/**
 * Em vez de tela preta quando algo quebra, mostra um aviso com "Recarregar".
 * Muda a chave (resetKey) a cada troca de página para tentar de novo.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientError(error, info.componentStack ?? undefined);
    if (isStaleBundle(error) && !sessionStorageFlag()) window.location.reload();
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <div className="crash-card">
          <h1>Algo não saiu como esperado</h1>
          <p>Esta tela teve um problema e já avisamos a equipe. Os seus dados estão salvos.</p>
          <div className="crash-actions">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Recarregar a página</button>
            <button type="button" className="btn" onClick={() => { this.setState({ error: null }); window.history.back(); }}>Voltar</button>
          </div>
        </div>
      </div>
    );
  }
}

/** Recarrega no máximo uma vez por sessão por versão antiga do site. */
function sessionStorageFlag() {
  try {
    if (sessionStorage.getItem('venceu-reloaded')) return true;
    sessionStorage.setItem('venceu-reloaded', '1');
  } catch {
    /* sem armazenamento: não recarrega em loop */
    return true;
  }
  return false;
}

/** Erros fora da renderização (ex.: em eventos e promessas) também são registrados. */
export function installGlobalErrorReporting() {
  let sent = 0;
  const report = (err: unknown) => {
    if (sent++ < 5) reportClientError(err);
  };
  window.addEventListener('error', (e) => report(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    // Erros de API já aparecem na tela (toasts/avisos): não precisam de relato.
    if (r && typeof r === 'object' && 'status' in r) return;
    report(r);
  });
}
