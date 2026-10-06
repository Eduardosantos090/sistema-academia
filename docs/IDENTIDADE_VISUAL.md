# Identidade visual

Arquivos em `web/public/brand/`, recortados das artes oficiais enviadas pelo cliente, com fundo removido
para uso sobre o tema escuro:

| Arquivo | Uso |
| --- | --- |
| `venceu-icone.png` | Ícone (calendário + robô): menu, página inicial |
| `venceu-logotipo.png` | Logotipo "Venceu" (branco + verde) |
| `venceu-logo-completa.png` | Marca completa com assinatura — telas de acesso |
| `icon-32/192/512.png`, `favicon.ico`, `apple-touch-icon.png` | Ícones do navegador e do app instalado |
| `venceu-divulgacao.jpg` | Imagem de compartilhamento (redes sociais) |

Paleta (tokens em `web/src/styles.css`): fundo `#060A08`, superfícies `#0F1714`, verde da marca `#2BE37A`,
texto `#E9F2ED`. O logotipo é branco: use somente sobre fundo escuro. Para trocar por versões vetoriais
oficiais, substitua os arquivos mantendo os nomes (ou ajuste `web/src/brand.ts`).
Fontes: Montserrat (títulos, próxima do logotipo) e Inter (texto), servidas localmente.
