/**
 * Startup script: generate Prisma client and verify/apply migrations before boot.
 * A package version alone does not prove that the database was migrated.
 */
import 'dotenv/config';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { backupDatabase } from '../src/lib/backupDatabase.js';
import { hasPendingMigrations, migrateSchema } from '../src/lib/migrateSchema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(__dirname, '..');
const rootDir = path.join(backendDir, '../..');
const versionFile = path.join(backendDir, 'prisma', '.version');

// Exit code telling the launcher the database migration failed
const MIGRATION_FAILED = 43;

const currentVersion = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8')).version;
const lastVersion = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf-8').trim() : null;

const run = (cmd) => execSync(cmd, { cwd: backendDir, stdio: 'inherit' });

// Always run prisma generate (fast, idempotent, fixes Windows DLL after update)
console.log('⚙️  Prisma generate...');
run('npx prisma generate');

try {
  const pending = hasPendingMigrations();
  if (lastVersion !== currentVersion || pending) {
    console.log(`📦 Version: ${lastVersion || 'none'} → ${currentVersion}; pending migrations: ${pending}`);
    const backupPath = backupDatabase({ reason: 'migration' });
    if (backupPath) console.log(`💾 Sauvegarde avant migration: ${backupPath}`);
  }

  console.log('⚙️  Vérification des migrations et du schéma...');
  const { baselined } = migrateSchema();
  if (baselined.length) {
    console.log(`   ${baselined.length} migration(s) marquée(s) comme déjà appliquées`);
  }
  if (lastVersion !== currentVersion || pending) fs.writeFileSync(versionFile, currentVersion);
  console.log(`✅ Version ${currentVersion} — schéma vérifié`);
} catch (err) {
  console.error('❌ Migration ou vérification de la base échouée; démarrage interrompu:', err.message);
  process.exit(MIGRATION_FAILED);
}
