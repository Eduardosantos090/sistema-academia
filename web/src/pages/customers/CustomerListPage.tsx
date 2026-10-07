import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import type { Customer, Paged } from '../../api/types';
import { Button, Empty, ErrorState, Loading, PageHeader, Pagination, SearchInput, Segmented, usePageTitle } from '../../components/ui';
import { Icon, WhatsAppIcon } from '../../components/icons';
import { CustomerFormModal } from '../../components/CustomerModals';
import { ImportCustomersModal } from '../../components/ImportCustomers';
import { fmtCents, fmtDate, fmtPhone, initials } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';

type Status = 'todos' | 'em_dia' | 'atrasados' | 'inativos';

export function CustomerListPage() {
  usePageTitle('Clientes');
  const nav = useNavigate();
  const [status, setStatus] = useState<Status>('todos');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const dq = useDebounced(q, 300);
  const list = useQuery({
    queryKey: ['customers', status, dq, page],
    queryFn: () => api.get<Paged<Customer>>(`/api/customers${qs({ status, q: dq, page, pageSize: 25 })}`),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <PageHeader
        title="Clientes"
        subtitle="Alunos, pacientes, assinantes — todos que recebem cobranças da sua empresa."
        actions={
          <>
            <a className="btn" href={`/api/customers/export${qs({ status, q: dq })}`} download>
              <Icon name="file" /> Exportar
            </a>
            <Button onClick={() => setImporting(true)}><Icon name="file" /> Importar planilha</Button>
            <Button variant="primary" onClick={() => setCreating(true)}><Icon name="plus" /> Novo cliente</Button>
          </>
        }
      />
      <div className="toolbar">
        <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Buscar por nome, e-mail, telefone ou CPF" label="Buscar clientes" />
        <Segmented<Status>
          label="Situação"
          value={status}
          onChange={(v) => { setStatus(v); setPage(1); }}
          options={[
            { id: 'todos', label: 'Ativos' },
            { id: 'em_dia', label: 'Em dia' },
            { id: 'atrasados', label: 'Em atraso' },
            { id: 'inativos', label: 'Inativos' },
          ]}
        />
      </div>
      <div className="card">
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data?.items.length ? (
          <Empty title={q ? 'Nenhum cliente encontrado' : 'Nenhum cliente por aqui'} icon="users">
            {!q && status === 'todos' && (
              <div className="row" style={{ justifyContent: 'center' }}>
                <Button onClick={() => setImporting(true)}><Icon name="file" /> Importar planilha</Button>
                <Button variant="primary" onClick={() => setCreating(true)}><Icon name="plus" /> Cadastrar o primeiro cliente</Button>
              </div>
            )}
          </Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table responsive">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Contato</th>
                    <th>Plano</th>
                    <th>Próximo vencimento</th>
                    <th>Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((c) => (
                    <tr key={c.id} style={{ cursor: 'pointer' }} onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) nav(`/app/clientes/${c.id}`); }}>
                      <td data-label="Cliente">
                        <div className="row-sm" style={{ flexWrap: 'nowrap' }}>
                          <span className="avatar" aria-hidden style={{ width: 30, height: 30, fontSize: '.72rem' }}>{initials(c.name)}</span>
                          <Link to={`/app/clientes/${c.id}`}>{c.name}</Link>
                        </div>
                      </td>
                      <td data-label="Contato">
                        <div className="stack-sm" style={{ gap: 2 }}>
                          {c.phone && <span className="row-sm small"><span style={{ color: c.whatsappOptIn ? 'var(--whatsapp)' : 'var(--text-faint)' }}><WhatsAppIcon size={14} /></span>{fmtPhone(c.phone)}</span>}
                          {c.email && <span className="small muted">{c.email}</span>}
                          {!c.phone && !c.email && <span className="faint small">sem contato</span>}
                        </div>
                      </td>
                      <td data-label="Plano">{c.planName ?? <span className="faint">—</span>}</td>
                      <td data-label="Próximo vencimento" className="num">{fmtDate(c.nextDueDate)}</td>
                      <td data-label="Situação">
                        {!c.isActive ? (
                          <span className="badge">Inativo</span>
                        ) : c.overdueCount > 0 ? (
                          <span className="badge badge-danger">{fmtCents(c.overdueCents)} em atraso</span>
                        ) : (
                          <span className="badge badge-success">Em dia</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
          </>
        )}
      </div>
      {importing && <ImportCustomersModal onClose={() => setImporting(false)} />}
      {creating && <CustomerFormModal onClose={() => setCreating(false)} onSaved={(id) => nav(`/app/clientes/${id}`)} />}
    </div>
  );
}
