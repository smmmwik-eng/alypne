import { existsSync } from 'node:fs';
import path from 'node:path';

if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

function str(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST;

const appSecret = str('APP_SECRET', isProd ? '' : 'dev-insecure-secret-change-me-dev-insecure-secret');
if (isProd && appSecret.length < 32) {
  throw new Error('APP_SECRET must be set to at least 32 random characters in production.');
}

export const env = {
  isProd,
  isTest,
  port: num('PORT', 8787),
  appUrl: str('APP_URL', 'http://localhost:5173').replace(/\/$/, ''),
  appSecret,
  /** `postgres://...` for a server, `pglite:<dir>` or `pglite:memory` for embedded Postgres. */
  databaseUrl: str('DATABASE_URL', isTest ? 'pglite:memory' : 'pglite:./data/pglite'),
  dataDir: path.resolve(str('DATA_DIR', './data')),
  smtpUrl: str('SMTP_URL'),
  mailFrom: str('MAIL_FROM', 'Alypne <no-reply@alypne.local>'),
  requireEmailVerification: str('REQUIRE_EMAIL_VERIFICATION', 'false') === 'true',
  uploadMaxBytes: num('UPLOAD_MAX_MB', 25) * 1024 * 1024,
  workspaceQuotaBytes: num('WORKSPACE_STORAGE_QUOTA_MB', 1024) * 1024 * 1024,
  robloxClientId: str('ROBLOX_OAUTH_CLIENT_ID'),
  robloxClientSecret: str('ROBLOX_OAUTH_CLIENT_SECRET'),
  githubToken: str('GITHUB_TOKEN'),
  allowPrivateWebhookTargets: str('ALLOW_PRIVATE_WEBHOOK_TARGETS', 'false') === 'true',
  disableWorker: str('DISABLE_WORKER', 'false') === 'true',
  trustProxy: str('TRUST_PROXY', 'false') === 'true',
};

export type Env = typeof env;
