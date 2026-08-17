const postgres = require('postgres');
process.loadEnvFile();
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: { rejectUnauthorized: false }, prepare: false, onnotice: () => undefined });

(async () => {
  const [u] = await sql`SELECT id, email, free_credits, free_credits_date, paid_credits FROM users WHERE email LIKE 'fresh-%' ORDER BY created_at DESC LIMIT 1`;
  console.log('row before    :', u);
  const balance = await sql`SELECT * FROM credit_balance(${u.id}::uuid, 5::integer)`;
  console.log('credit_balance:', balance[0]);
  const [after] = await sql`SELECT free_credits, free_credits_date FROM users WHERE id = ${u.id}`;
  console.log('row after     :', after);
  await sql.end();
})();
