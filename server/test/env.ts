export const TEST_ENV = {
  APP_ENV: 'test',
  APP_URL: 'http://localhost:5173',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://venceu_app:dev_app_pw@127.0.0.1:5432/venceu_test',
  DATABASE_OWNER_URL: process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://venceu_owner:dev_owner_pw@127.0.0.1:5432/venceu_test',
  LOG_LEVEL: process.env.TEST_LOG ?? 'silent',
} as const;
