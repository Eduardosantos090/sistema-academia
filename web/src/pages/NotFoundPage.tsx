import { Link } from 'react-router-dom';
import { Empty, usePageTitle } from '../components/ui';

export function NotFoundPage({ standalone }: { standalone?: boolean }) {
  usePageTitle('Página não encontrada');
  const body = (
    <Empty title="Página não encontrada" icon="alert">
      <p>O endereço não existe ou você não tem acesso a ele.</p>
      <Link to={standalone ? '/' : '/app'} className="btn btn-primary">Voltar</Link>
    </Empty>
  );
  return standalone ? <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>{body}</div> : body;
}
