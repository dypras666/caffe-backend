/**
 * migrate-all.js — jalankan migrations untuk semua tenant sekaligus
 *
 * Usage:
 *   node database/migrate-all.js              # migrate semua tenant aktif
 *   node database/migrate-all.js --slug=soto  # migrate satu tenant saja
 *   node database/migrate-all.js --dry-run    # cek tanpa apply
 *
 * Butuh env REGISTRY_DB_* untuk connect ke registry.
 * Bisa juga set lewat .env di root project.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const { execSync } = require('child_process');
const path = require('path');

const REGISTRY = {
  host:     process.env.REGISTRY_DB_HOST || '127.0.0.1',
  port:     parseInt(process.env.REGISTRY_DB_PORT || '3306'),
  user:     process.env.REGISTRY_DB_USER || 'root',
  password: process.env.REGISTRY_DB_PASS || process.env.REGISTRY_DB_PASSWORD || 'CafeAzzura2024',
  database: process.env.REGISTRY_DB_NAME || 'cafe_registry',
};

const SHARED_DB = {
  host: process.env.SHARED_DB_HOST || '127.0.0.1',
  port: parseInt(process.env.SHARED_DB_PORT || '3910'),
};

const args = process.argv.slice(2);
const slugFilter = args.find(a => a.startsWith('--slug='))?.split('=')[1];
const dryRun     = args.includes('--dry-run');
const verbose    = args.includes('--verbose') || args.includes('-v');

async function getTenantsFromRegistry() {
  const reg = await mysql.createConnection(REGISTRY);
  const [rows] = await reg.query(
    `SELECT slug, db_name, db_user, db_pass FROM tenants WHERE status = 'active' ORDER BY created_at`,
  );
  await reg.end();
  return rows;
}

async function migrateTenant(tenant) {
  const { slug, db_name, db_user, db_pass } = tenant;

  if (dryRun) {
    console.log(`  [dry-run] would migrate ${slug} (${db_name})`);
    return { slug, status: 'dry-run' };
  }

  // Temporarily set env vars for the child migrate process
  const env = {
    ...process.env,
    DB_HOST:     SHARED_DB.host,
    DB_PORT:     String(SHARED_DB.port),
    DB_USER:     db_user,
    DB_PASSWORD: db_pass,
    DB_NAME:     db_name,
  };

  try {
    const output = execSync(
      `node ${path.join(__dirname, 'migrate.js')}`,
      { env, encoding: 'utf8', timeout: 120_000 }
    );
    if (verbose) console.log(output);
    const match = output.match(/(\d+) new, (\d+) skipped/);
    const newCount = match ? parseInt(match[1]) : '?';
    return { slug, status: 'ok', new: newCount };
  } catch (err) {
    const msg = err.stdout || err.stderr || err.message;
    return { slug, status: 'error', error: msg.trim().slice(0, 200) };
  }
}

async function main() {
  console.log('\n🔄  cafe-backend migrate-all\n');

  if (dryRun) console.log('  Mode: DRY RUN — tidak ada perubahan yang diterapkan\n');

  let tenants;
  try {
    tenants = await getTenantsFromRegistry();
  } catch (e) {
    // Fallback: baca dari env (single-tenant mode)
    if (process.env.DB_NAME) {
      console.log('  Registry tidak tersedia — migrate single tenant dari env\n');
      tenants = [{
        slug:     process.env.TENANT_SLUG || 'local',
        db_name:  process.env.DB_NAME,
        db_user:  process.env.DB_USER,
        db_pass:  process.env.DB_PASSWORD,
      }];
    } else {
      console.error('  ❌ Tidak bisa connect ke registry dan tidak ada DB_NAME di env');
      console.error('  Error:', e.message);
      process.exit(1);
    }
  }

  if (slugFilter) {
    tenants = tenants.filter(t => t.slug === slugFilter);
    if (!tenants.length) {
      console.error(`  ❌ Tenant "${slugFilter}" tidak ditemukan`);
      process.exit(1);
    }
  }

  console.log(`  Tenant ditemukan: ${tenants.length}\n`);

  const results = [];
  for (const tenant of tenants) {
    process.stdout.write(`  ⟳  ${tenant.slug.padEnd(30)} `);
    const result = await migrateTenant(tenant);
    if (result.status === 'ok') {
      console.log(`✅  ${result.new} migration baru`);
    } else if (result.status === 'dry-run') {
      console.log(`⏭  dry-run`);
    } else {
      console.log(`❌  ERROR`);
      console.error(`     ${result.error}`);
    }
    results.push(result);
  }

  const ok    = results.filter(r => r.status === 'ok').length;
  const err   = results.filter(r => r.status === 'error').length;
  const total = results.filter(r => r.status !== 'dry-run').length;

  console.log(`\n✅  Selesai: ${ok}/${total} berhasil${err ? `, ${err} error` : ''}\n`);
  if (err) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
