import { loadDotEnv } from '../src/lib/dotenv.js';
import { migrate } from './migrate-lib.js';

loadDotEnv();
const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('Defina DATABASE_OWNER_URL.');
  process.exit(1);
}
await migrate(url);
console.log('Migrações concluídas.');
