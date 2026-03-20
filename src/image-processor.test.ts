import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock os before importing the module
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, default: { ...actual, platform: vi.fn(() => 'darwin') } };
});

// Mock config
vi.mock('./config.js', () => ({
  OLLAMA_HOST: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen2.5-vl:7b',
  IMAGE_PROCESSOR_ENABLED: true,
  IMAGE_TEMP_DIR: '/tmp/nanoclaw-vision-test',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock mac-system-ocr as unavailable by default
vi.mock('mac-system-ocr', () => {
  throw new Error('Not available');
});

import os from 'os';
import {
  analyzeViaOllama,
  checkImageTools,
  formatImageContent,
  IMAGE_PROCESSOR_AVAILABLE,
  processImage,
} from './image-processor.js';
import type { ImageProcessorResult } from './image-processor.js';

describe('image-processor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkImageTools', () => {
    it('returns unavailable on Linux', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');
      // Mock fetch to reject (no Ollama)
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      );

      const result = await checkImageTools();

      expect(result.available).toBe(false);
      expect(result.missing).toContain('macOS (required for Apple Vision OCR)');
    });

    it('returns unavailable when Ollama is unreachable', async () => {
      vi.mocked(os.platform).mockReturnValue('darwin');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      );

      const result = await checkImageTools();

      expect(result.available).toBe(false);
      expect(result.missing).toContain('ollama');
    });
  });

  describe('analyzeViaOllama', () => {
    it('returns structured result on success', async () => {
      const mockAnalysis = {
        sender: 'John Doe',
        date: '2026-01-15',
        reference: 'INV-2026-001',
        summary: 'Invoice for consulting services',
        deadline: '2026-02-15',
        tone: 'formal',
        action: 'reply_needed',
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ response: JSON.stringify(mockAnalysis) }),
        }),
      );

      // Mock fs.readFileSync for the image
      const fs = await import('fs');
      vi.spyOn(fs.default, 'readFileSync').mockReturnValue(
        Buffer.from('fake-image-data'),
      );

      const result = await analyzeViaOllama('/tmp/test.jpg', 'Invoice text');

      expect(result).not.toBeNull();
      expect(result!.sender).toBe('John Doe');
      expect(result!.summary).toBe('Invoice for consulting services');
      expect(result!.tone).toBe('formal');
      expect(result!.action).toBe('reply_needed');
    });

    it('returns null when Ollama is unreachable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      );

      const result = await analyzeViaOllama('/tmp/test.jpg', 'some text');

      expect(result).toBeNull();
    });

    it('returns null on non-OK response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 500 }),
      );

      const fs = await import('fs');
      vi.spyOn(fs.default, 'readFileSync').mockReturnValue(
        Buffer.from('fake-image-data'),
      );

      const result = await analyzeViaOllama('/tmp/test.jpg', 'some text');

      expect(result).toBeNull();
    });
  });

  describe('processImage', () => {
    it('returns null when IMAGE_PROCESSOR_AVAILABLE is false', async () => {
      // checkImageTools was called in the Linux test above, setting it to false
      // Force it by calling checkImageTools with Linux platform
      vi.mocked(os.platform).mockReturnValue('linux');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      );
      await checkImageTools();

      const result = await processImage('/tmp/test.jpg');

      expect(result).toBeNull();
    });
  });

  describe('formatImageContent', () => {
    it('returns correct string format with analysis summary', () => {
      const result: ImageProcessorResult = {
        processedAt: '2026-01-15T10:00:00.000Z',
        ocrText: 'Invoice for consulting services rendered in January 2026',
        analysis: {
          sender: 'John Doe',
          date: '2026-01-15',
          reference: 'INV-2026-001',
          summary: 'Invoice for consulting services',
          deadline: '2026-02-15',
          tone: 'formal',
          action: 'reply_needed',
        },
      };

      const formatted = formatImageContent('/path/to/file.json', result);

      expect(formatted).toBe(
        '[letter]: /path/to/file.json — Invoice for consulting services',
      );
    });

    it('falls back to OCR text when no analysis', () => {
      const result: ImageProcessorResult = {
        processedAt: '2026-01-15T10:00:00.000Z',
        ocrText: 'Some OCR text from the image',
        analysis: null,
      };

      const formatted = formatImageContent('/path/to/file.json', result);

      expect(formatted).toBe(
        '[letter]: /path/to/file.json — Some OCR text from the image',
      );
    });
  });
});
