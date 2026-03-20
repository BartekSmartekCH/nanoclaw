import { execFile, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// Resolve tool paths — launchd has a minimal PATH, so we check common locations
function findTool(name: string): string | null {
  const searchPaths = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ];
  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback: try which with a full PATH
  try {
    return execSync(`PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH" which ${name}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const WHISPER_PATH = findTool('whisper');
const EDGE_TTS_PATH = findTool('edge-tts');
const FFMPEG_PATH = findTool('ffmpeg');

// Environment with /opt/homebrew/bin in PATH — needed because launchd has minimal PATH
// and whisper/edge-tts internally shell out to ffmpeg
const TOOL_ENV = {
  ...process.env,
  PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:${process.env.PATH || ''}`,
};

// --- Types ---

export interface VoiceConfig {
  enabled: boolean;
  language: string; // whisper language hint, e.g. "es"
  tts_voice: string; // edge-tts voice, e.g. "en-IE-EmilyNeural"
  provider: string; // "edge-tts" (future: "elevenlabs")
  max_tts_chars: number; // skip TTS above this
}

export interface STTProvider {
  transcribe(audioPath: string, language: string): Promise<string | null>;
}

export interface TTSProvider {
  synthesize(
    text: string,
    voice: string,
    outputPath: string,
  ): Promise<boolean>;
}

// --- Constants ---

export const VOICE_TEMP_DIR = path.join(os.tmpdir(), 'nanoclaw-voice');
const PROCESS_TIMEOUT = 30_000;
const STALE_FILE_AGE = 60 * 60 * 1000; // 1 hour
const VOICE_PREFIX = '[voice]: ';

// --- Startup checks ---

export let VOICE_AVAILABLE = false;

export function checkVoiceTools(): {
  available: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!WHISPER_PATH) missing.push('whisper');
  if (!EDGE_TTS_PATH) missing.push('edge-tts');
  if (!FFMPEG_PATH) missing.push('ffmpeg');

  const available = missing.length === 0;
  VOICE_AVAILABLE = available;

  if (available) {
    logger.info(
      { whisper: WHISPER_PATH, edgeTts: EDGE_TTS_PATH, ffmpeg: FFMPEG_PATH, tempDir: VOICE_TEMP_DIR },
      'Voice tools available',
    );
  } else {
    logger.warn(
      { missing },
      'Voice disabled — missing tools. Install them to enable voice support',
    );
  }

  return { available, missing };
}

// --- Temp file management ---

export function ensureTempDir(): void {
  fs.mkdirSync(VOICE_TEMP_DIR, { recursive: true });
}

export function cleanupTempDir(): void {
  if (!fs.existsSync(VOICE_TEMP_DIR)) return;

  const now = Date.now();
  for (const file of fs.readdirSync(VOICE_TEMP_DIR)) {
    const filePath = path.join(VOICE_TEMP_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > STALE_FILE_AGE) {
        fs.unlinkSync(filePath);
        logger.debug({ file }, 'Cleaned up stale voice temp file');
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

function tempPath(msgId: string, ext: string): string {
  return path.join(VOICE_TEMP_DIR, `${msgId}.${ext}`);
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

// --- Config ---

export function loadVoiceConfig(groupFolder: string): VoiceConfig | null {
  const configPath = path.join(GROUPS_DIR, groupFolder, 'voice.json');
  try {
    if (!fs.existsSync(configPath)) return null;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!config.enabled) return null;
    return {
      enabled: true,
      language: config.language || 'en',
      tts_voice: config.tts_voice || 'en-IE-EmilyNeural',
      provider: config.provider || 'edge-tts',
      max_tts_chars: config.max_tts_chars ?? 2000,
    };
  } catch (err) {
    logger.warn({ groupFolder, err }, 'Failed to load voice config');
    return null;
  }
}

// --- Helpers ---

export function isVoiceMessage(content: string): boolean {
  return content.startsWith(VOICE_PREFIX);
}

// --- STT: Whisper ---

const whisperSTT: STTProvider = {
  async transcribe(
    audioPath: string,
    language: string,
  ): Promise<string | null> {
    const msgId = path.basename(audioPath, path.extname(audioPath));
    const wavPath = tempPath(msgId, 'wav');

    try {
      // Convert OGG → WAV for whisper
      await execFileAsync(
        FFMPEG_PATH!,
        ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', wavPath],
        { timeout: PROCESS_TIMEOUT, env: TOOL_ENV },
      );

      // Run whisper
      const outputDir = VOICE_TEMP_DIR;
      const whisperResult = await execFileAsync(
        WHISPER_PATH!,
        [
          wavPath,
          '--language',
          language,
          '--model',
          'base',
          '--fp16',
          'False',
          '--output_format',
          'txt',
          '--output_dir',
          outputDir,
        ],
        { timeout: PROCESS_TIMEOUT, env: TOOL_ENV },
      );
      // Whisper writes a .txt file named after the input file
      const txtPath = path.join(outputDir, `${msgId}.txt`);
      if (fs.existsSync(txtPath)) {
        const text = fs.readFileSync(txtPath, 'utf-8').trim();
        safeUnlink(txtPath);
        safeUnlink(wavPath);
        return text || null;
      }

      logger.warn({ audioPath }, 'Whisper output file not found');
      return null;
    } catch (err) {
      logger.error({ audioPath, err }, 'Whisper transcription failed');
      return null;
    } finally {
      safeUnlink(wavPath);
    }
  },
};

// --- TTS: edge-tts ---

const edgeTTS: TTSProvider = {
  async synthesize(
    text: string,
    voice: string,
    outputPath: string,
  ): Promise<boolean> {
    const mp3Path = outputPath.replace(/\.ogg$/, '.mp3');

    try {
      // edge-tts → MP3
      await execFileAsync(
        EDGE_TTS_PATH!,
        ['--voice', voice, '--text', text, '--write-media', mp3Path],
        { timeout: PROCESS_TIMEOUT, env: TOOL_ENV },
      );

      // ffmpeg MP3 → OGG (Telegram-compatible opus)
      await execFileAsync(
        FFMPEG_PATH!,
        ['-y', '-i', mp3Path, '-c:a', 'libopus', '-b:a', '64k', outputPath],
        { timeout: PROCESS_TIMEOUT, env: TOOL_ENV },
      );

      safeUnlink(mp3Path);
      return true;
    } catch (err) {
      logger.error({ voice, err }, 'TTS synthesis failed');
      safeUnlink(mp3Path);
      return false;
    }
  },
};

// --- Public API ---

export async function transcribe(
  oggPath: string,
  language: string,
): Promise<string | null> {
  return whisperSTT.transcribe(oggPath, language);
}

export async function synthesize(
  text: string,
  voice: string,
  msgId: string,
): Promise<string | null> {
  ensureTempDir();
  const oggPath = tempPath(msgId, 'ogg');

  const success = await edgeTTS.synthesize(text, voice, oggPath);
  if (success && fs.existsSync(oggPath)) {
    return oggPath;
  }
  safeUnlink(oggPath);
  return null;
}

export function formatVoiceContent(transcription: string): string {
  return `${VOICE_PREFIX}${transcription}`;
}
