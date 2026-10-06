import { fmtCents, fmtCentsCompact, monthLabel } from '../lib/format';

export interface SeriesPoint {
  month: string;
  receivedCents: number;
  billedCents: number;
  overdueCents: number;
}

/**
 * Barras por mês: faturado (fundo), recebido (verde) e em atraso (vermelho).
 * SVG puro, acessível por tabela equivalente (sr-only).
 */
export function RevenueChart({ data }: { data: SeriesPoint[] }) {
  const W = 640;
  const H = 230;
  const pad = { l: 56, r: 8, t: 12, b: 28 };
  const max = Math.max(1, ...data.map((d) => Math.max(d.billedCents, d.receivedCents + d.overdueCents)));
  const nice = niceMax(max);
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / Math.max(1, data.length);
  const bw = Math.min(46, slot * 0.56);
  const y = (v: number) => pad.t + ih - (v / nice) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * nice);
  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Recebido, faturado e em atraso por mês">
        <defs>
          <linearGradient id="gReceived" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#5BF59A" />
            <stop offset="1" stopColor="#12A955" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={pad.l - 8} y={y(t) + 4} textAnchor="end">
              {fmtCentsCompact(t).replace(',00', '')}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = pad.l + slot * i + slot / 2;
          return (
            <g key={d.month}>
              <rect className="bar-billed" x={cx - bw / 2} y={y(d.billedCents)} width={bw} height={Math.max(0, y(0) - y(d.billedCents))} rx={6} />
              <rect className="bar-received" x={cx - bw / 2 + 5} y={y(d.receivedCents)} width={bw - 10} height={Math.max(0, y(0) - y(d.receivedCents))} rx={4} />
              {d.overdueCents > 0 && (
                <rect
                  className="bar-overdue"
                  x={cx - bw / 2 + 5}
                  y={y(d.receivedCents + d.overdueCents)}
                  width={bw - 10}
                  height={Math.max(0, y(d.receivedCents) - y(d.receivedCents + d.overdueCents))}
                  rx={4}
                />
              )}
              <text className="axis" x={cx} y={H - 8} textAnchor="middle">
                {monthLabel(d.month)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="legend" style={{ marginTop: 6 }}>
        <span><i style={{ background: 'var(--brand)' }} />Recebido</span>
        <span><i style={{ background: 'var(--danger)' }} />Em atraso</span>
        <span><i style={{ background: 'var(--surface-3)' }} />Faturado</span>
      </figcaption>
      <table className="sr-only">
        <caption>Valores por mês</caption>
        <thead>
          <tr><th>Mês</th><th>Faturado</th><th>Recebido</th><th>Em atraso</th></tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.month}>
              <td>{monthLabel(d.month)}</td>
              <td>{fmtCents(d.billedCents)}</td>
              <td>{fmtCents(d.receivedCents)}</td>
              <td>{fmtCents(d.overdueCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function niceMax(v: number) {
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * exp;
}

export function Donut({ value, label }: { value: number | null; label: string }) {
  const v = value ?? 0;
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 100 100" width="112" height="112" role="img" aria-label={`${label}: ${value === null ? 'sem dados' : `${v}%`}`}>
      <circle cx="50" cy="50" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="10" />
      <circle
        cx="50" cy="50" r={r} fill="none" stroke="var(--brand)" strokeWidth="10" strokeLinecap="round"
        strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 50 50)"
        style={{ filter: 'drop-shadow(0 0 6px rgba(43,227,122,.5))' }}
      />
      <text x="50" y="55" textAnchor="middle" fontSize="20" fontWeight="800" fill="var(--text)" fontFamily="var(--font-display)">
        {value === null ? '—' : `${v}%`}
      </text>
    </svg>
  );
}
