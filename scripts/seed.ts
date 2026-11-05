import { fileURLToPath } from 'node:url';
import { withClient } from '../src/db/client.ts';
import { nodeClients } from './node-db.ts';

// Fixed IDs make the fictional fixture repeatable; no Telegram identities or delivery.
export async function seed(url: string): Promise<void> {
  await withClient(nodeClients(url), async (tx) => {
    await tx.query('BEGIN');
    try {
      await tx.query("SET LOCAL lock_timeout = '3s'");
      await tx.query('INSERT INTO shop(id,name,address) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [1,'Тестовый Бородач','Вымышленная улица, 1']);
      await tx.query('SELECT id FROM shop WHERE id=$1 FOR UPDATE', [1]);
      await tx.query('INSERT INTO settings(shop_id) VALUES($1) ON CONFLICT(shop_id) DO NOTHING', [1]);
      await tx.query('INSERT INTO ranks(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', ['00000000-0000-4000-8000-000000000001','Тестовый ранг']);
      await tx.query('INSERT INTO barbers(id,rank_id,name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
        ['00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Вымышленный мастер']);
      await tx.query('INSERT INTO services(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', ['00000000-0000-4000-8000-000000000003','Тестовая стрижка']);
      await tx.query('INSERT INTO rank_tariffs(rank_id,service_id,price_kopecks,duration_minutes) VALUES($1,$2,$3,$4) ON CONFLICT(rank_id,service_id) DO NOTHING',
        ['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',150000,45]);
      await tx.query('INSERT INTO assignments(barber_id,service_id) VALUES($1,$2) ON CONFLICT(barber_id,service_id) DO NOTHING',
        ['00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003']);
      await tx.query('COMMIT');
    } catch (error) { await tx.query('ROLLBACK'); throw error; }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) { console.error('TEST_DATABASE_URL is required'); process.exitCode = 1; }
  else { try { await seed(url); console.log('Fictional fixture seeded'); } catch { console.error('Seed failed'); process.exitCode = 1; } }
}
