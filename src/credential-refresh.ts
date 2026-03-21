/**
 * Auth recovery: read fresh OAuth token from macOS Keychain
 * and update .env so the credential proxy picks it up.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const ENV_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * Read the current OAuth token from macOS Keychain.
 * Returns null on non-macOS or if the credential isn't found.
 */
async function readKeychainToken(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;

  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w',
    ]);

    const raw = stdout.trim();
    if (!raw) return null;

    // Keychain stores JSON: { claudeAiOauth: { accessToken: "sk-ant-oat01-..." } }
    const parsed = JSON.parse(raw);
    const token = parsed?.claudeAiOauth?.accessToken;
    if (!token || typeof token !== 'string') {
      logger.warn('Keychain credential missing claudeAiOauth.accessToken');
      return null;
    }

    return token;
  } catch (err) {
    logger.warn({ err }, 'Failed to read token from Keychain');
    return null;
  }
}

/**
 * Update a single key in the .env file. Preserves all other lines.
 * Uses a lock file to prevent races with the watchdog script.
 */
function updateEnvKey(key: string, value: string): void {
  const envPath = path.join(process.cwd(), '.env');
  const lockPath = envPath + '.lock';

  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch {
    logger.warn('updateEnvKey: .env lock busy — skipping update');
    return;
  }

  try {
    let content: string;
    try {
      content = fs.readFileSync(envPath, 'utf-8');
    } catch {
      content = '';
    }

    const lines = content.split('\n');
    let found = false;

    const updated = lines.map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`) || trimmed.startsWith(`${key} =`)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });

    if (!found) {
      updated.push(`${key}=${value}`);
    }

    fs.writeFileSync(envPath, updated.join('\n'));
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read fresh OAuth token from Keychain and update .env if it differs.
 */
export async function refreshOAuthToken(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const keychainToken = await readKeychainToken();
    if (!keychainToken) {
      return {
        success: false,
        error:
          process.platform !== 'darwin'
            ? 'Keychain not available (not macOS)'
            : 'Could not read token from Keychain',
      };
    }

    const envVars = readEnvFile([ENV_KEY]);
    const currentToken = envVars[ENV_KEY] || '';

    if (currentToken === keychainToken) {
      logger.info('Keychain token matches .env — no update needed');
      return { success: true };
    }

    updateEnvKey(ENV_KEY, keychainToken);
    logger.info('OAuth token updated in .env from Keychain');
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Failed to refresh OAuth token');
    return { success: false, error: msg };
  }
}

/**
 * Quick health check: verify the credential proxy is running and
 * a token is configured. We can't fully replicate the Claude Code SDK's
 * multi-step OAuth exchange in a simple check, so we verify:
 *   1. The proxy is reachable
 *   2. A token exists in .env (API key or OAuth)
 *   3. For OAuth: the Keychain token matches .env (not stale)
 */
export async function checkAuthHealth(proxyPort = 3001): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const envVars = readEnvFile([ENV_KEY, 'ANTHROPIC_API_KEY']);
    const hasApiKey = !!envVars.ANTHROPIC_API_KEY;
    const hasOAuth = !!envVars[ENV_KEY];

    if (!hasApiKey && !hasOAuth) {
      return { ok: false, error: 'No API key or OAuth token in .env' };
    }

    // Check proxy is reachable
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'OPTIONS',
    }).catch(() => null);

    if (!res) {
      return { ok: false, error: 'Credential proxy not reachable' };
    }

    // For OAuth: check if Keychain token matches .env (detect stale token)
    if (hasOAuth && process.platform === 'darwin') {
      const keychainToken = await readKeychainToken();
      if (keychainToken && keychainToken !== envVars[ENV_KEY]) {
        return {
          ok: false,
          error:
            'Token in .env is stale (differs from Keychain). Run /fix_auth',
        };
      }
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Health check failed: ${msg}` };
  }
}
