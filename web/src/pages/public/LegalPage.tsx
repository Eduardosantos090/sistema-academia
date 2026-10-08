import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { brand } from '../../brand';
import { usePageTitle } from '../../components/ui';
import { BrandMark } from '../../layout/AppLayout';

const L = brand.legal;
const Mail = () => <a href={`mailto:${L.contactEmail}`}>{L.contactEmail}</a>;

function LegalShell({ title, children }: { title: string; children: ReactNode }) {
  usePageTitle(title);
  useEffect(() => window.scrollTo(0, 0), []);
  return (
    <div className="landing">
      <header className="l-nav">
        <Link to="/" className="brand" aria-label="Venceu — página inicial"><BrandMark /></Link>
        <nav aria-label="Documentos">
          <Link className="l-link" to="/termos">Termos de uso</Link>
          <Link className="l-link" to="/privacidade">Privacidade</Link>
          <Link to="/" className="btn">Voltar ao site</Link>
        </nav>
      </header>
      <main className="legal">
        <h1>{title}</h1>
        <p className="muted small">Última atualização: {L.updatedAt}</p>
        {children}
      </main>
      <footer className="l-footer">
        <span>© {new Date().getFullYear()} Venceu · {brand.tagline}</span>
        <span>{brand.credit}</span>
      </footer>
    </div>
  );
}

export function TermsPage() {
  return (
    <LegalShell title="Termos de Uso">
      <p>
        Estes Termos regem o uso do <strong>Venceu</strong> (a “Plataforma”), serviço de lembretes de vencimento, cobrança recorrente e
        atendimento automatizado oferecido por {L.responsible} (“nós”). Ao criar uma conta, contratar uma assinatura ou usar a
        Plataforma, você (“Cliente”) declara que leu e concorda com estes Termos e com a <Link to="/privacidade">Política de Privacidade</Link>.
      </p>

      <h2>1. O serviço</h2>
      <p>
        O Venceu permite cadastrar clientes, planos e cobranças; enviar lembretes por WhatsApp e e-mail; responder mensagens por um
        assistente virtual; gerar links de pagamento por PIX; e acompanhar quem está em dia. A Plataforma é fornecida como serviço
        online (SaaS), acessado pelo navegador, sem instalação.
      </p>

      <h2>2. Conta e acesso</h2>
      <ul>
        <li>Você deve informar dados verdadeiros e mantê-los atualizados. A conta é da empresa contratante; o responsável cadastrado responde pelos acessos que conceder à sua equipe.</li>
        <li>Login e senha são pessoais e intransferíveis. Avise-nos imediatamente em caso de uso não autorizado.</li>
        <li>Você deve ter capacidade legal para contratar em nome da empresa informada.</li>
      </ul>

      <h2>3. Assinatura, pagamento e renovação</h2>
      <ul>
        <li>O acesso é cobrado por assinatura recorrente, no valor e periodicidade exibidos no momento da contratação (por exemplo, R$ 50,00 por mês). Os pagamentos são processados pela <strong>AbacatePay</strong>, de acordo com os termos dela; não armazenamos dados de cartão.</li>
        <li>A assinatura é <strong>renovada automaticamente</strong> a cada período, até ser cancelada.</li>
        <li>Se um pagamento não for concluído, o acesso continua durante um período de tolerância e depois é suspenso até a regularização. Os seus dados são mantidos conforme a Política de Privacidade.</li>
        <li>Podemos alterar o preço mediante aviso prévio de pelo menos 30 dias; a mudança vale a partir da renovação seguinte. Se não concordar, você pode cancelar antes dela.</li>
      </ul>

      <h2>4. Cancelamento e reembolso</h2>
      <ul>
        <li>Você pode cancelar a qualquer momento, sem multa nem fidelidade, pelo canal de contato abaixo ou pela AbacatePay. O cancelamento interrompe as cobranças futuras, e o acesso continua até o fim do período já pago.</li>
        <li><strong>Direito de arrependimento:</strong> na primeira contratação, você pode desistir em até 7 (sete) dias e receber o valor pago de volta, conforme o art. 49 do Código de Defesa do Consumidor, quando aplicável.</li>
        <li>Fora dessa hipótese, não há reembolso proporcional de períodos já iniciados.</li>
      </ul>

      <h2>5. Uso aceitável</h2>
      <p>Ao usar a Plataforma, você se compromete a:</p>
      <ul>
        <li>Enviar mensagens apenas a pessoas com quem tem relação comercial e que autorizaram o contato, respeitando os pedidos de descadastro (todo e-mail enviado inclui um link para isso).</li>
        <li>Não usar o Venceu para spam, cobrança abusiva ou vexatória, golpes, conteúdo ilegal ou que viole direitos de terceiros. A cobrança deve respeitar o art. 42 do Código de Defesa do Consumidor.</li>
        <li>Cumprir as políticas dos serviços que você conectar, como as do WhatsApp/Meta e as do seu provedor de e-mail. Bloqueios aplicados por esses serviços ao seu número ou conta são de sua responsabilidade.</li>
        <li>Não tentar acessar dados de outras empresas, contornar limites ou medidas de segurança, nem fazer engenharia reversa da Plataforma.</li>
      </ul>
      <p>O descumprimento pode levar à suspensão ou ao encerramento da conta.</p>

      <h2>6. Dados dos seus clientes</h2>
      <p>
        Os dados que você cadastra sobre os seus clientes (nome, telefone, e-mail, cobranças, conversas) pertencem a você. Em relação a
        eles, você é o <strong>controlador</strong> e nós somos <strong>operador</strong>, nos termos da Lei Geral de Proteção de Dados
        (Lei 13.709/2018). Tratamos esses dados apenas para prestar o serviço e conforme as suas instruções, como descrito na{' '}
        <Link to="/privacidade">Política de Privacidade</Link>. Cabe a você ter base legal para tratá-los e para enviar as mensagens.
      </p>

      <h2>7. Integrações de terceiros</h2>
      <p>
        Algumas funções dependem de serviços de terceiros que você escolhe conectar: API do WhatsApp (Meta) ou outros integradores,
        provedores de e-mail e AbacatePay. Esses serviços têm termos, preços e disponibilidade próprios. Não respondemos por falhas,
        mudanças ou cobranças deles.
      </p>

      <h2>8. Disponibilidade e suporte</h2>
      <p>
        Trabalhamos para manter a Plataforma disponível e segura, mas ela pode passar por manutenções e interrupções eventuais. O suporte
        é prestado pelo e-mail <Mail />. Recomendamos exportar periodicamente os seus dados, o que pode ser feito em planilha pelo próprio painel.
      </p>

      <h2>9. Responsabilidade</h2>
      <p>
        O Venceu é uma ferramenta de apoio: não garantimos que os seus clientes vão pagar, nem que mensagens serão entregues quando
        dependerem de terceiros. Na máxima extensão permitida pela lei, a nossa responsabilidade por danos diretos fica limitada ao
        valor pago por você nos 12 meses anteriores ao fato, e não respondemos por lucros cessantes ou danos indiretos. Isso não
        afasta direitos garantidos ao consumidor pela legislação.
      </p>

      <h2>10. Propriedade intelectual</h2>
      <p>
        A Plataforma, a marca Venceu, os logotipos e o software são protegidos por lei. A assinatura dá a você um direito de uso, pessoal
        e intransferível, enquanto ela estiver ativa. Nenhum direito de propriedade é transferido.
      </p>

      <h2>11. Encerramento</h2>
      <p>
        Encerrada a conta, por cancelamento ou suspensão definitiva, você pode pedir a exportação dos seus dados em até 30 dias. Depois
        desse prazo, os dados podem ser excluídos, ressalvadas as informações que a lei nos obrigue a guardar.
      </p>

      <h2>12. Alterações e disposições gerais</h2>
      <p>
        Podemos atualizar estes Termos. Mudanças relevantes serão comunicadas com antecedência pelo e-mail cadastrado ou na Plataforma.
        Estes Termos seguem a lei brasileira. Fica eleito o foro do domicílio do Cliente quando ele for consumidor; nos demais casos, o
        foro do domicílio do responsável pela Plataforma.
      </p>

      <h2>Contato</h2>
      <p>{L.responsible} — <Mail /></p>
    </LegalShell>
  );
}

export function PrivacyPage() {
  return (
    <LegalShell title="Política de Privacidade">
      <p>
        Esta Política explica como o <strong>Venceu</strong>, oferecido por {L.responsible}, trata dados pessoais, de acordo com a Lei
        Geral de Proteção de Dados (Lei 13.709/2018, “LGPD”).
      </p>

      <h2>1. Papéis</h2>
      <ul>
        <li><strong>Dados de quem contrata e usa o Venceu</strong> (responsáveis e equipes das empresas clientes, visitantes do site): nós somos o <strong>controlador</strong>.</li>
        <li><strong>Dados dos clientes das empresas</strong> (por exemplo, alunos, pacientes e associados cadastrados para receber lembretes): a empresa cliente é a <strong>controladora</strong>, e nós atuamos como <strong>operador</strong>, tratando os dados apenas para prestar o serviço contratado. Pedidos sobre esses dados devem ser feitos primeiro à empresa com quem a pessoa tem relação.</li>
      </ul>

      <h2>2. Dados que coletamos</h2>
      <ul>
        <li><strong>Cadastro e contratação:</strong> nome, nome da empresa, segmento, e-mail, WhatsApp, CPF ou CNPJ (opcional) e senha. A senha é guardada apenas como resumo criptográfico (hash), nunca em texto.</li>
        <li><strong>Pagamento:</strong> a cobrança é feita pela AbacatePay. Recebemos dela apenas a situação da assinatura e dos pagamentos e os dados de identificação do cliente. Não recebemos nem guardamos números de cartão.</li>
        <li><strong>Uso da Plataforma:</strong> registros de acesso e de ações (data, hora, endereço IP, ação realizada), mantidos para segurança e auditoria.</li>
        <li><strong>Formulário de contato:</strong> os dados que você enviar para pedir acesso.</li>
        <li><strong>Dados inseridos pelas empresas clientes</strong> sobre os clientes delas: nome, telefone, e-mail, CPF (opcional), cobranças, mensagens e anexos enviados ou recebidos pelo WhatsApp e e-mail.</li>
      </ul>

      <h2>3. Para que usamos e com qual base legal</h2>
      <ul>
        <li>Criar e manter a conta, prestar o serviço, cobrar a assinatura e dar suporte (execução de contrato).</li>
        <li>Segurança, prevenção a fraudes e registros de acesso (legítimo interesse e cumprimento do Marco Civil da Internet).</li>
        <li>Cumprir obrigações legais e fiscais (obrigação legal).</li>
        <li>Responder a pedidos de contato (procedimentos preliminares a contrato, a seu pedido).</li>
        <li>Enviar lembretes, confirmações e respostas automáticas em nome das empresas clientes (como operador, conforme as instruções delas).</li>
      </ul>
      <p>Não vendemos dados pessoais e não os usamos para publicidade.</p>

      <h2>4. Com quem compartilhamos</h2>
      <p>Apenas com fornecedores necessários para o funcionamento do serviço, que tratam os dados em nosso nome ou por escolha da empresa cliente:</p>
      <ul>
        <li><strong>Hospedagem e banco de dados:</strong> Netlify e Supabase. Os servidores podem ficar fora do Brasil (por exemplo, no Canadá), com as salvaguardas do art. 33 da LGPD.</li>
        <li><strong>Pagamentos:</strong> AbacatePay.</li>
        <li><strong>Mensagens:</strong> WhatsApp/Meta ou o integrador escolhido pela empresa cliente, e o provedor de e-mail configurado (o da plataforma ou o da própria empresa).</li>
        <li><strong>Autoridades:</strong> quando houver obrigação legal ou ordem judicial.</li>
      </ul>

      <h2>5. Por quanto tempo guardamos</h2>
      <ul>
        <li><strong>Dados da conta:</strong> enquanto a conta existir. Depois do encerramento, por até 30 dias para exportação, salvo obrigação legal de guarda.</li>
        <li><strong>Registros de acesso:</strong> pelo prazo mínimo de 6 meses exigido pelo Marco Civil da Internet.</li>
        <li><strong>Cadastros iniciados e não pagos:</strong> expiram em 3 dias. A senha informada é apagada nesse momento.</li>
        <li><strong>Dados dos clientes das empresas:</strong> enquanto a empresa mantiver a conta, ou até que ela os exclua.</li>
      </ul>

      <h2>6. Segurança</h2>
      <p>
        Usamos conexões criptografadas (HTTPS/TLS) e senhas com hash forte. As chaves de integração (WhatsApp, e-mail e pagamento) ficam
        guardadas criptografadas. O banco de dados isola os dados de cada empresa, e as ações ficam registradas em auditoria. Os
        perfis de acesso são separados (responsável e equipe). Nenhum sistema é totalmente imune a incidentes. Se ocorrer algum
        incidente relevante, comunicaremos os afetados e a ANPD, conforme a LGPD.
      </p>

      <h2>7. Cookies</h2>
      <p>
        Usamos apenas o cookie essencial de sessão, que mantém você conectado com segurança. Não usamos cookies de publicidade nem de
        rastreamento de terceiros.
      </p>

      <h2>8. Seus direitos</h2>
      <p>
        Você pode pedir: confirmação de que tratamos seus dados; acesso; correção; anonimização, bloqueio ou eliminação de dados
        desnecessários; portabilidade; informação sobre compartilhamentos; e revogação de consentimento, quando ele for a base legal.
        Também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD). Para quem recebe lembretes por e-mail, há sempre um link de descadastro
        na própria mensagem. No WhatsApp, basta responder pedindo para não receber mais.
      </p>

      <h2>9. Encarregado e contato</h2>
      <p>
        Pedidos sobre dados pessoais podem ser enviados a {L.responsible}, responsável pelo tratamento (encarregado), pelo e-mail{' '}
        <Mail />. Responderemos em até 15 dias.
      </p>

      <h2>10. Alterações</h2>
      <p>
        Podemos atualizar esta Política. A data no topo indica a versão vigente. Mudanças relevantes serão avisadas na Plataforma ou
        por e-mail.
      </p>
      <p className="muted small">Veja também os <Link to="/termos">Termos de Uso</Link>.</p>
    </LegalShell>
  );
}
