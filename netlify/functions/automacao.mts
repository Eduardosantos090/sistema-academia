// Tarefa agendada (a cada minuto): cobranças recorrentes, lembretes, envio da fila e limpeza.
import { handleMaintenance } from '../../server/src/serverless.ts';

export default async () => {
  await handleMaintenance();
};

export const config = { schedule: '* * * * *' };
