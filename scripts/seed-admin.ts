import { Pool } from "pg";
import bcrypt from "bcryptjs";

const email = process.env.ADMIN_SEED_EMAIL;
const password = process.env.ADMIN_SEED_PASSWORD;

if (!email || !password) {
  console.error("ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD must be set");
  process.exit(1);
}

const pg = new Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pg.query("SELECT id FROM admin_users WHERE email = $1", [email]);
if (rows.length > 0) {
  console.log(`Admin user ${email} already exists (id=${rows[0].id}), skipping.`);
} else {
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await pg.query(
    "INSERT INTO admin_users (email, password_hash) VALUES ($1, $2) RETURNING id",
    [email, passwordHash],
  );
  console.log(`Created admin user ${email} (id=${result.rows[0].id}).`);
}

await pg.end();
