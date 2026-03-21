#!/usr/bin/env node
import { execFile } from 'child_process';
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const NANOCLAW_HOME = process.env.NANOCLAW_HOME ?? join(SCRIPT_DIR, '..');
const ENV_PATH = join(NANOCLAW_HOME, '.env');
const LOG_PATH = join(process.env.HOME, 'Library/Logs/nanoclaw-watchdog.log');
const LOG_MAX_BYTES = 1_000_000;
const ENV_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';
const LAUNCHD_LABEL = process.env.NANOCLAW_LAUNCHD_LABEL ?? 'com.nanoclaw';

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  try {
    try { if (statSync(LOG_PATH).size > LOG_MAX_BYTES) writeFileSync(LOG_PATH, ''); } catch {}
    writeFileSync(LOG_PATH, line, { flag: 'a' });
  } catch {}
}

async function readKeychainToken() {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-w',
    ]);
    const raw = stdout.trim();
    if (!raw) { log('WARN: Keychain returned empty value'); return null; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      log(`ERROR: Keychain JSON parse failed — ${e.message}`);
      return null;
    }
    const token = parsed?.claudeAiOauth?.accessToken;
    if (!token) { log('ERROR: claudeAiOauth.accessToken missing'); return null; }
    return token;
  } catch (err) {
    log(`ERROR: Keychain read failed — ${err.message}`);
    return null;
  }
}

function readEnvToken() {
  try {
    const lines = readFileSync(ENV_PATH, 'utf-8').split('\n');
    const line = lines.find(l => l.startsWith(`${ENV_KEY}=`));
    if (!line) return null;
    return line.slice(ENV_KEY.length + 1).split('#')[0].trim() || null;
  } catch { return null; }
}

function updateEnvToken(token) {
  const lockPath = ENV_PATH + '.lock';
  try { writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); }
  catch { log('WARN: .env lock busy — skipping update'); return; }
  try {
    let content;
    try { content = readFileSync(ENV_PATH, 'utf-8'); } catch { content = ''; }
    const lines = content.split('\n');
    let found = false;
    const updated = lines.map(l => {
      if (l.startsWith(`${ENV_KEY}=`)) { found = true; return `${ENV_KEY}=${token}`; }
      return l;
    });
    if (!found) updated.push(`${ENV_KEY}=${token}`);
    writeFileSync(ENV_PATH, updated.join('\n'));
  } finally {
    try { unlinkSync(lockPath); } catch {}
  }
}

async function isProcessRunning() {
  try {
    const uid = process.getuid();
    const { stdout } = await execFileAsync('launchctl', [
      'print', `gui/${uid}/${LAUNCHD_LABEL}`,
    ]);
    return stdout.includes('state = running');
  } catch { return false; }
}

async function restart() {
  const uid = process.getuid();
  try {
    await execFileAsync('launchctl', ['kickstart', '-k', `gui/${uid}/${LAUNCHD_LABEL}`]);
    log('NanoClaw restarted via launchctl');
  } catch (err) {
    log(`ERROR: launchctl restart failed — ${err.message}`);
  }
}

// --- main ---
const keychainToken = await readKeychainToken();
if (!keychainToken) {
  log('Skipping — no token available from Keychain');
  process.exit(1);
}

const envToken = readEnvToken();
let needsRestart = false;

if (keychainToken !== envToken) {
  updateEnvToken(keychainToken);
  log('Token updated in .env from Keychain');
  needsRestart = true;
}

const running = await isProcessRunning();
if (!running) {
  log(`NanoClaw not running (label: ${LAUNCHD_LABEL})`);
  needsRestart = true;
}

if (needsRestart) {
  await restart();
} else {
  log('OK — token fresh, process running');
}
