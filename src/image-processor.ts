import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  IMAGE_PROCESSOR_ENABLED,
  IMAGE_TEMP_DIR,
  OLLAMA_HOST,
  OLLAMA_MODEL,
} from './config.js';
import { logger } from './logger.js';

// --- Types ---

export interface ImageAnalysis {
  sender: string | null;
  date: string | null;
  reference: string | null;
  summary: string;
  deadline: string | null;
  tone: 'routine' | 'formal' | 'urgent' | 'legal' | 'junk';
  action: 'reply_needed' | 'info_only' | 'urgent' | 'junk';
}

export interface ImageProcessorResult {
  processedAt: string;
  ocrText: string;
  analysis: ImageAnalysis | null;
}

// --- Constants ---

const STALE_FILE_AGE = 60 * 60 * 1000; // 1 hour
const OLLAMA_TIMEOUT = 60_000;
const OLLAMA_CHECK_TIMEOUT = 3_000;
const IPC_DIR = path.resolve(process.cwd(), 'data', 'ipc', 'files');

// --- Optional dependency: mac-system-ocr ---

let macOcr: { recognize: (imagePath: string) => Promise<string> } | null = null;

// --- Startup state ---

export let IMAGE_PROCESSOR_AVAILABLE = false;

// --- Startup checks ---

export async function checkImageTools(): Promise<{
  available: boolean;
  missing: string[];
}> {
  const missing: string[] = [];

  if (os.platform() !== 'darwin') {
    missing.push('macOS (required for Apple Vision OCR)');
  }

  // Try to load mac-system-ocr
  try {
    const mod = await import('mac-system-ocr');
    const MacOCR = mod.default as any;
    macOcr = {
      recognize: async (imagePath: string) => {
        const result = await MacOCR.recognize(imagePath);
        return result.text;
      },
    };
  } catch {
    macOcr = null;
    missing.push('mac-system-ocr');
  }

  // Check Ollama
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      OLLAMA_CHECK_TIMEOUT,
    );
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      missing.push('ollama (unhealthy response)');
    }
  } catch {
    missing.push('ollama');
  }

  const available = missing.length === 0 && IMAGE_PROCESSOR_ENABLED;
  IMAGE_PROCESSOR_AVAILABLE = available;

  if (available) {
    logger.info(
      { ollamaHost: OLLAMA_HOST, ollamaModel: OLLAMA_MODEL, tempDir: IMAGE_TEMP_DIR },
      'Image processor available',
    );
  } else {
    logger.warn(
      { missing },
      'Image processor disabled — missing dependencies. Install them to enable image processing',
    );
  }

  return { available, missing };
}

// --- Temp file management ---

function ensureImageTempDir(): void {
  fs.mkdirSync(IMAGE_TEMP_DIR, { recursive: true });
}

export async function downloadImageToTemp(
  url: string,
  fileId: string,
): Promise<string> {
  ensureImageTempDir();

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(new URL(url).pathname) || '.jpg';
  const filePath = path.join(IMAGE_TEMP_DIR, `${fileId}${ext}`);
  fs.writeFileSync(filePath, buffer);

  return filePath;
}

export function cleanupImageTemp(): void {
  if (!fs.existsSync(IMAGE_TEMP_DIR)) return;

  const now = Date.now();
  for (const file of fs.readdirSync(IMAGE_TEMP_DIR)) {
    const filePath = path.join(IMAGE_TEMP_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > STALE_FILE_AGE) {
        fs.unlinkSync(filePath);
        logger.debug({ file }, 'Cleaned up stale image temp file');
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

// --- Apple Vision OCR ---

export async function extractTextAppleVision(
  imagePath: string,
): Promise<string | null> {
  if (!macOcr) return null;

  try {
    const text = await macOcr.recognize(imagePath);
    return text?.trim() || null;
  } catch (err) {
    logger.warn({ imagePath, err }, 'Apple Vision OCR failed');
    return null;
  }
}

// --- Ollama analysis ---

export async function analyzeViaOllama(
  imagePath: string,
  ocrText: string,
): Promise<ImageAnalysis | null> {
  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');

    const prompt = `You are analyzing an image of a document or letter. OCR text extracted from it:

---
${ocrText || '(no OCR text available)'}
---

Analyze the image and return ONLY a JSON object with these fields:
- sender: who sent this (string or null)
- date: date on the document (string or null)
- reference: any reference number (string or null)
- summary: one-line summary of the content (string, required)
- deadline: any deadline mentioned (string or null)
- tone: one of "routine", "formal", "urgent", "legal", "junk"
- action: one of "reply_needed", "info_only", "urgent", "junk"

Return ONLY valid JSON, no markdown, no explanation.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT);

    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        images: [base64Image],
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      logger.warn(
        { status: res.status },
        'Ollama returned non-OK response',
      );
      return null;
    }

    const data = (await res.json()) as { response?: string };
    if (!data.response) return null;

    // Extract JSON from response — Ollama may wrap it in markdown fences
    let jsonStr = data.response.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);

    // Validate required fields
    const validTones = ['routine', 'formal', 'urgent', 'legal', 'junk'] as const;
    const validActions = ['reply_needed', 'info_only', 'urgent', 'junk'] as const;

    const analysis: ImageAnalysis = {
      sender: parsed.sender ?? null,
      date: parsed.date ?? null,
      reference: parsed.reference ?? null,
      summary: String(parsed.summary || 'No summary available'),
      deadline: parsed.deadline ?? null,
      tone: validTones.includes(parsed.tone) ? parsed.tone : 'routine',
      action: validActions.includes(parsed.action) ? parsed.action : 'info_only',
    };

    return analysis;
  } catch (err) {
    logger.warn({ imagePath, err }, 'Ollama analysis failed');
    return null;
  }
}

// --- Main public API ---

export async function processImage(
  imagePath: string,
): Promise<ImageProcessorResult | null> {
  if (!IMAGE_PROCESSOR_AVAILABLE) return null;

  const ocrText = (await extractTextAppleVision(imagePath)) || '';
  const analysis = await analyzeViaOllama(imagePath, ocrText);

  return {
    processedAt: new Date().toISOString(),
    ocrText,
    analysis,
  };
}

// --- IPC file writer ---

export function writeImageResultFile(
  msgId: string,
  result: ImageProcessorResult,
): string {
  fs.mkdirSync(IPC_DIR, { recursive: true });

  const timestamp = Date.now();
  const fileName = `letter-${msgId}-${timestamp}.json`;
  const filePath = path.join(IPC_DIR, fileName);

  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');

  return filePath;
}

// --- Format for agent ---

export function formatImageContent(
  filePath: string,
  result: ImageProcessorResult,
): string {
  const summary =
    result.analysis?.summary || result.ocrText.slice(0, 80) || 'image';
  return `[letter]: ${filePath} — ${summary}`;
}
