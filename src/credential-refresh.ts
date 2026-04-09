/**
 * Auth recovery: read fresh OAuth token from macOS Keychain
 * and update .env so the credential proxy picks it up.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const ENV_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

const CLAUDE_CLI =
  process.env.CLAUDE_CLI_PATH || `${process.env.HOME}/.local/bin/claude`;

/**
 * Run `claude -p ping` to trigger the OAuth refresh token flow.
 * The CLI exchanges the long-lived refresh token for a new access token
 * and writes it back to the macOS Keychain.
 */
export async function runClaudePing(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    await execFileAsync(
      CLAUDE_CLI,
      ['--print', 'ping', '--dangerously-skip-permissions'],
      {
        timeout: 30000,
      },
    );
    logger.info(
      'Claude CLI ping succeeded — OAuth token refreshed in Keychain',
    );
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err },
      'Claude CLI ping failed — interactive re-auth may be required',
    );
    return { success: false, error: msg };
  }
}

/**
 * Read the current OAuth token from macOS Keychain.
 * Returns null on non-macOS or if the credential isn't found.
 */
interface KeychainResult {
  token: string | null;
  expiresAt: number;
}

async function readKeychainTokenWithExpiry(): Promise<KeychainResult> {
  if (process.platform !== 'darwin') return { token: null, expiresAt: 0 };

  // Check both service names (mirrors getFreshKeychainToken in credential-proxy)
  const services = [
    'Claude Code-credentials-6b0d98c8',
    'Claude Code-credentials',
  ];
  let bestToken: string | null = null;
  let bestExpiry = 0;

  for (const svc of services) {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-s',
        svc,
        '-w',
      ]);

      const raw = stdout.trim();
      if (!raw) continue;

      const parsed = JSON.parse(raw);
      const oauth = parsed?.claudeAiOauth;
      if (!oauth?.accessToken || typeof oauth.accessToken !== 'string')
        continue;
      const expiresAt: number = oauth.expiresAt ?? 0;
      if (expiresAt > Date.now() && expiresAt > bestExpiry) {
        bestToken = oauth.accessToken;
        bestExpiry = expiresAt;
      }
    } catch {
      // keychain entry missing or parse error — skip
    }
  }

  if (!bestToken) {
    logger.warn('No valid (non-expired) OAuth token found in Keychain');
  }
  return { token: bestToken, expiresAt: bestExpiry };
}

async function readKeychainToken(): Promise<string | null> {
  return (await readKeychainTokenWithExpiry()).token;
}

/**
 * Get the current token's expiry timestamp (ms since epoch).
 * Returns null if no token or not on macOS.
 */
export async function getTokenExpiry(): Promise<number | null> {
  const { expiresAt } = await readKeychainTokenWithExpiry();
  return expiresAt > 0 ? expiresAt : null;
}

/**
 * Update a single key in the .env file. Preserves all other lines.
 */
function updateEnvKey(key: string, value: string): void {
  const envPath = path.join(process.cwd(), '.env');

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

  // Atomic write: write to temp file then rename to avoid partial reads
  const tmpPath = path.join(path.dirname(envPath), `.env.tmp.${process.pid}`);
  fs.writeFileSync(tmpPath, updated.join('\n'));
  fs.renameSync(tmpPath, envPath);
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

    // For OAuth: verify a valid (non-expired) token exists in Keychain.
    // The credential proxy reads directly from Keychain, so .env staleness
    // is no longer an error — only a missing/expired Keychain token is.
    if (hasOAuth && process.platform === 'darwin') {
      const keychainToken = await readKeychainToken();
      if (!keychainToken) {
        return {
          ok: false,
          error: 'No valid OAuth token in Keychain — run `claude auth login`',
        };
      }
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Health check failed: ${msg}` };
  }
}

/**
 * Verify the current token actually works by making a lightweight API call
 * through the credential proxy. Returns true if the API accepts the token.
 *
 * In OAuth mode, we hit the exchange endpoint — a 403 (permission error) still
 * proves the token is valid (Anthropic recognized it but it lacks a scope).
 * Only a 401 means the token is truly invalid/revoked.
 */
export async function verifyTokenViaApi(
  proxyPort = 3001,
): Promise<{ ok: boolean; error?: string }> {
  const envVars = readEnvFile(['ANTHROPIC_API_KEY']);
  const isApiKeyMode = !!envVars.ANTHROPIC_API_KEY;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let res: Response;
    if (isApiKeyMode) {
      // API key mode: test with count_tokens
      res = await fetch(
        `http://127.0.0.1:${proxyPort}/v1/messages/count_tokens`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            messages: [{ role: 'user', content: 'test' }],
          }),
          signal: controller.signal,
        },
      );
    } else {
      // OAuth mode: test the exchange endpoint — 403 = token valid (wrong scope), 401 = invalid
      res = await fetch(
        `http://127.0.0.1:${proxyPort}/api/oauth/claude_cli/create_api_key`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer placeholder',
          },
          body: JSON.stringify({}),
          signal: controller.signal,
        },
      );
    }
    clearTimeout(timeout);

    if (res.status === 401) {
      return { ok: false, error: 'Token rejected by API (401)' };
    }
    // Any other status (200, 400, 403, 429) means the token was accepted
    logger.debug(
      { status: res.status },
      'Token verified via API',
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Token verification failed: ${msg}` };
  }
}
