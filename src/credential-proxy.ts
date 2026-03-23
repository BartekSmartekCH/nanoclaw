/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { execSync } from 'child_process';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Read the freshest valid OAuth token from macOS Keychain.
 * Claude Code stores credentials under two service names; pick whichever
 * has the latest non-expired expiresAt.  Falls back to undefined so callers
 * can fall through to .env.
 */
function getFreshKeychainToken(): string | undefined {
  const services = [
    'Claude Code-credentials-6b0d98c8',
    'Claude Code-credentials',
  ];
  let bestToken: string | undefined;
  let bestExpiry = 0;

  for (const svc of services) {
    try {
      const raw = execSync(
        `security find-generic-password -s ${JSON.stringify(svc)} -w 2>/dev/null`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      const data = JSON.parse(raw);
      const oauth = data?.claudeAiOauth;
      if (!oauth?.accessToken) continue;
      const expiresAt: number = oauth.expiresAt ?? 0;
      if (expiresAt > Date.now() && expiresAt > bestExpiry) {
        bestToken = oauth.accessToken;
        bestExpiry = expiresAt;
      }
    } catch {
      // keychain entry missing or parse error — skip
    }
  }

  return bestToken;
}

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  // Read once at startup for upstream URL (stable) and initial auth mode
  const initSecrets = readEnvFile(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);

  const upstreamUrl = new URL(
    initSecrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        // Re-read credentials on each request so token refreshes take effect
        const secrets = readEnvFile([
          'ANTHROPIC_API_KEY',
          'CLAUDE_CODE_OAUTH_TOKEN',
          'ANTHROPIC_AUTH_TOKEN',
        ]);
        const authMode: AuthMode = secrets.ANTHROPIC_API_KEY
          ? 'api-key'
          : 'oauth';
        const oauthToken =
          getFreshKeychainToken() ||
          secrets.CLAUDE_CODE_OAUTH_TOKEN ||
          secrets.ANTHROPIC_AUTH_TOKEN;

        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      const mode = initSecrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
      logger.info({ port, host, authMode: mode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
