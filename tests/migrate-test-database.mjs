import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient } from './notification-fixtures.mjs';

const client = createTestClient();
try {
  await migrate(drizzle(client), { migrationsFolder: './drizzle' });
  console.log('Disposable notification test database migrated.');
} finally {
  await client.end();
}
