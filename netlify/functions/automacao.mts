// Tarefa agendada (a cada 15 min): cobranças recorrentes, lembretes, envio da fila e limpeza.
import { handleMaintenance } from '../../server/src/serverless.ts';

export default async () => {
  await handleMaintenance();
};

export const config = { schedule: '*/15 * * * *' };
