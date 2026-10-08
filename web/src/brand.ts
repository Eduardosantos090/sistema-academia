/**
 * Identidade visual do Venceu — ponto único de configuração.
 * Arquivos recortados das artes oficiais enviadas pelo cliente, com fundo
 * transparente para uso sobre o tema escuro. Ver docs/IDENTIDADE_VISUAL.md.
 */
export const brand = {
  name: 'Venceu',
  tagline: 'Lembretes de vencimento com automação de chatbot',
  icon: { src: '/brand/venceu-icone.png', width: 480, height: 375 },
  wordmark: { src: '/brand/venceu-logotipo.png', width: 720, height: 163 },
  full: { src: '/brand/venceu-logo-completa.png', width: 720, height: 643 },
  credit: 'Tecnologia desenvolvida pela PMG Code',
  /** Dados exibidos nos Termos de Uso e na Política de Privacidade. */
  legal: {
    responsible: 'Eduardo Sobral',
    contactEmail: 'santooos1034@icloud.com',
    updatedAt: '8 de outubro de 2026',
  },
} as const;

export const appTitle = 'Venceu';
