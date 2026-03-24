import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { checkAuthHealth, refreshOAuthToken, runClaudePing } from '../credential-refresh.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  VOICE_AVAILABLE,
  VOICE_TEMP_DIR,
  loadVoiceConfig,
  transcribe,
  formatVoiceContent,
  ensureTempDir,
} from '../voice.js';
import {
  IMAGE_PROCESSOR_AVAILABLE,
  downloadImageToTemp,
  processImage,
  writeImageResultFile,
  formatImageContent as formatImageProcessorContent,
} from '../image-processor.js';
import { registerChannel, ChannelOpts, SystemStatus } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSystemStatus?: () => SystemStatus;
  toggleTextOnly?: (chatJid: string) => boolean;
  switchModel?: (chatJid: string, model: string | null) => string;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    // Rename the bot to match the sender's role, then wait for Telegram to propagate
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          api,
          numericId,
          text.slice(i, i + MAX_LENGTH),
        );
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to check API auth health (main group only)
    this.bot.command('health', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group?.isMain) {
        ctx.reply('This command is only available in the main group.');
        return;
      }
      const result = await checkAuthHealth();
      if (result.ok) {
        ctx.reply('✅ API auth is working.');
      } else {
        ctx.reply(`❌ API auth failed: ${result.error}`);
      }
    });

    // Command to refresh OAuth token from Keychain (main group only)
    this.bot.command('fix_auth', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group?.isMain) {
        ctx.reply('This command is only available in the main group.');
        return;
      }
      ctx.reply('Refreshing auth token from Keychain...');
      await runClaudePing();
      const result = await refreshOAuthToken();
      if (result.success) {
        ctx.reply(
          '✅ Token refreshed. Next agent call will use the new token.',
        );
      } else {
        ctx.reply(
          `❌ Refresh failed: ${result.error}\nRun \`claude\` on the Mac mini to re-authenticate.`,
        );
      }
    });

    // Command to show available commands
    this.bot.command('help', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];

      if (!group) {
        ctx.reply(
          [
            `*${ASSISTANT_NAME} commands:*`,
            '',
            "/chatid — Show this chat's registration ID",
            '/ping — Check if bot is online',
            '/help — This message',
            '',
            `This chat is not registered. Use /chatid to get the ID, then register it via the main group.`,
          ].join('\n'),
          { parse_mode: 'Markdown' },
        );
        return;
      }

      const lines = [
        `*${ASSISTANT_NAME} commands:*`,
        '',
        '/ping — Check if bot is online',
        '/chatid — Show chat registration ID',
        '/help — List available commands',
      ];

      if (group.isMain) {
        lines.push(
          '/status — System health and queue status',
          '/health — Test API authentication',
          '/fix\\_auth — Refresh OAuth token from Keychain',
          '/compact — Compact agent context window',
          '/remote-control — Start Claude Code bridge',
          '/remote-control-end — Stop Claude Code bridge',
        );
      }

      lines.push('', `Mention @${ASSISTANT_NAME} to talk to the agent.`);

      ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    });

    // Command to show system status (main group only)
    this.bot.command('status', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group?.isMain) {
        ctx.reply('This command is only available in the main group.');
        return;
      }

      const status = this.opts.getSystemStatus?.();
      const auth = await checkAuthHealth();

      const lines = [`*${ASSISTANT_NAME} status:*`, ''];

      if (status) {
        const totalSec = Math.floor(status.uptimeMs / 1000);
        const days = Math.floor(totalSec / 86400);
        const hours = Math.floor((totalSec % 86400) / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const parts: string[] = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        parts.push(`${mins}m`);
        lines.push(`Uptime: ${parts.join(' ')}`);
        lines.push(`Groups: ${status.groupCount} registered`);

        if (status.queueActive === 0 && status.queueWaiting === 0) {
          lines.push('Queue: idle');
        } else {
          const parts2: string[] = [];
          if (status.queueActive > 0)
            parts2.push(`${status.queueActive} active`);
          if (status.queueWaiting > 0)
            parts2.push(`${status.queueWaiting} waiting`);
          lines.push(`Queue: ${parts2.join(', ')}`);
        }
      }

      const authText = auth.ok
        ? 'OK'
        : `FAILED — ${auth.error?.replace(/_/g, '\\_')}`;
      lines.push(`Auth: ${authText}`);

      ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    });

    // /text — toggle text-only mode (suppresses voice mirror replies)
    this.bot.command('text', (ctx) => {
      if (!this.opts.toggleTextOnly) return;
      const chatJid = `tg:${ctx.chat.id}`;
      const isTextOnly = this.opts.toggleTextOnly(chatJid);
      ctx.reply(isTextOnly ? '💬 Text mode on' : '🔁 Mirror mode');
    });

    // /model — switch AI model (sonnet, opus, haiku, ollama)
    this.bot.command('model', (ctx) => {
      if (!this.opts.switchModel) return;
      const chatJid = `tg:${ctx.chat.id}`;
      const arg = ctx.match?.trim().toLowerCase() || null;
      const validModels = ['sonnet', 'opus', 'haiku', 'ollama'];
      if (arg && !validModels.includes(arg)) {
        ctx.reply(`Valid models: ${validModels.join(', ')}`);
        return;
      }
      const current = this.opts.switchModel(chatJid, arg);
      if (arg) {
        ctx.reply(`Switched to *${current}*`, { parse_mode: 'Markdown' });
      } else {
        ctx.reply(`Current model: *${current}*`, { parse_mode: 'Markdown' });
      }
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set([
      'chatid',
      'ping',
      'health',
      'fix_auth',
      'help',
      'status',
      'text',
      'model',
    ]);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      if (!IMAGE_PROCESSOR_AVAILABLE) {
        storeNonText(ctx, '[Photo]');
        return;
      }
      const chatJid = `tg:${ctx.chat.id}`;
      const msgId = ctx.message.message_id.toString();
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      try {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const file = await ctx.api.getFile(photo.file_id);
        if (!file.file_path) {
          storeNonText(ctx, '[Photo]');
          return;
        }
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const imgPath = await downloadImageToTemp(
          fileUrl,
          photo.file_unique_id,
        );
        const result = await processImage(imgPath);
        if (!result) {
          storeNonText(ctx, '[Photo - processing failed]');
          return;
        }
        const filePath = writeImageResultFile(msgId, result);
        const caption = ctx.message.caption || '';
        const content = formatImageProcessorContent(filePath, result);
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: caption ? `${content}\n${caption}` : content,
          timestamp,
          is_from_me: false,
        });
        logger.info({ chatJid, msgId }, 'Photo processed via image processor');
      } catch (err) {
        logger.error({ err }, 'Error processing photo');
        storeNonText(ctx, '[Photo - processing error]');
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const voiceConfig = VOICE_AVAILABLE
        ? loadVoiceConfig(group.folder)
        : null;
      if (!voiceConfig) {
        storeNonText(ctx, '[Voice message]');
        return;
      }

      const msgId = ctx.message.message_id.toString();
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      try {
        // Download voice file from Telegram
        ensureTempDir();
        const file = await ctx.api.getFile(ctx.message.voice.file_id);
        if (!file.file_path) {
          logger.warn({ msgId }, 'Telegram returned no file_path for voice');
          storeNonText(ctx, '[Voice message]');
          return;
        }
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const oggPath = `${VOICE_TEMP_DIR}/${msgId}.ogg`;

        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(oggPath);
          out.on('error', reject);
          https
            .get(fileUrl, (res) => {
              res.pipe(out);
              out.on('finish', () => {
                out.close();
                resolve();
              });
            })
            .on('error', (err) => {
              out.destroy();
              reject(err);
            });
        });

        // Transcribe
        const text = await transcribe(oggPath, voiceConfig.language);

        // Cleanup downloaded file
        try {
          fs.unlinkSync(oggPath);
        } catch {
          /* ignore */
        }

        const content = text
          ? formatVoiceContent(text)
          : '[Voice message — transcription failed]';

        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });

        logger.info(
          { chatJid, msgId, transcribed: !!text },
          'Voice message processed',
        );
      } catch (err) {
        logger.error({ chatJid, msgId, err }, 'Voice processing failed');
        storeNonText(ctx, '[Voice message]');
      }
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const mime = ctx.message.document?.mime_type || '';
      const name = ctx.message.document?.file_name || 'file';
      if (mime.startsWith('text/')) {
        const doc = ctx.message.document!;
        const chatJid = `tg:${ctx.chat.id}`;
        const msgId = ctx.message.message_id.toString();
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Unknown';
        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroup,
        );
        try {
          const file = await ctx.api.getFile(doc.file_id);
          if (!file.file_path) {
            storeNonText(ctx, `[Document: ${name}]`);
            return;
          }
          const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const raw = await fetch(fileUrl).then((r) => r.text());
          const MAX = 65_536;
          const truncated =
            raw.length > MAX ? raw.slice(0, MAX) + '\n[...truncated]' : raw;
          const caption = ctx.message.caption ? `\n${ctx.message.caption}` : '';
          const content = `[File: ${name}]\n\`\`\`\n${truncated}\n\`\`\`${caption}`;
          this.opts.onMessage(chatJid, {
            id: msgId,
            chat_jid: chatJid,
            sender: ctx.from?.id?.toString() || '',
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: false,
          });
          logger.info({ chatJid, msgId, mime }, 'Text document extracted');
        } catch (err) {
          logger.error({ err }, 'Error reading text document');
          storeNonText(ctx, `[Document: ${name}]`);
        }
        return;
      }
      // Binary document types: save to group folder so the agent can access them
      const SAVE_TO_GROUP_MIMES = [
        'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
      ];
      const SAVE_TO_GROUP_EXTS = ['.pptx', '.xlsx', '.docx', '.potx'];
      const ext = path.extname(name).toLowerCase();
      if (
        SAVE_TO_GROUP_MIMES.includes(mime) ||
        SAVE_TO_GROUP_EXTS.includes(ext)
      ) {
        const chatJid = `tg:${ctx.chat.id}`;
        const group = this.opts.registeredGroups()[chatJid];
        if (group) {
          try {
            const doc = ctx.message.document!;
            const file = await ctx.api.getFile(doc.file_id);
            if (file.file_path) {
              const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
              const res = await fetch(fileUrl);
              const buffer = Buffer.from(await res.arrayBuffer());
              const groupDir = path.resolve('groups', group.folder);
              const savePath = path.join(groupDir, name);
              fs.mkdirSync(groupDir, { recursive: true });
              fs.writeFileSync(savePath, buffer);
              logger.info(
                { chatJid, name, groupDir },
                'Document saved to group folder',
              );

              const msgId = ctx.message.message_id.toString();
              const timestamp = new Date(ctx.message.date * 1000).toISOString();
              const senderName =
                ctx.from?.first_name ||
                ctx.from?.username ||
                ctx.from?.id?.toString() ||
                'Unknown';
              const caption = ctx.message.caption
                ? `\n${ctx.message.caption}`
                : '';
              this.opts.onMessage(chatJid, {
                id: msgId,
                chat_jid: chatJid,
                sender: ctx.from?.id?.toString() || '',
                sender_name: senderName,
                content: `[File saved: ${name} → /workspace/group/${name}]${caption}`,
                timestamp,
                is_from_me: false,
              });
            }
          } catch (err) {
            logger.error(
              { err, name },
              'Error saving document to group folder',
            );
            storeNonText(ctx, `[Document: ${name}]`);
          }
        } else {
          storeNonText(ctx, `[Document: ${name}]`);
        }
        return;
      }
      if (
        !IMAGE_PROCESSOR_AVAILABLE ||
        (!mime.startsWith('image/') && mime !== 'application/pdf')
      ) {
        storeNonText(ctx, `[Document: ${name}]`);
        return;
      }
      const chatJid = `tg:${ctx.chat.id}`;
      const msgId = ctx.message.message_id.toString();
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      try {
        const doc = ctx.message.document!;
        const file = await ctx.api.getFile(doc.file_id);
        if (!file.file_path) {
          storeNonText(ctx, `[Document: ${name}]`);
          return;
        }
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const imgPath = await downloadImageToTemp(fileUrl, doc.file_unique_id);
        const result = await processImage(imgPath);
        if (!result) {
          storeNonText(ctx, `[Document: ${name}]`);
          return;
        }
        const filePath = writeImageResultFile(msgId, result);
        const caption = ctx.message.caption || '';
        const content = formatImageProcessorContent(filePath, result);
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: caption ? `${content}\n${caption}` : content,
          timestamp,
          is_from_me: false,
        });
        logger.info(
          { chatJid, msgId, mime },
          'Document processed via image processor',
        );
      } catch (err) {
        logger.error({ err }, 'Error processing document');
        storeNonText(ctx, `[Document: ${name}]`);
      }
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Register command menu with Telegram for autocomplete
    const defaultCommands = [
      { command: 'ping', description: 'Check if bot is online' },
      { command: 'chatid', description: 'Show chat registration ID' },
      { command: 'help', description: 'List available commands' },
      { command: 'status', description: 'System health check' },
      { command: 'dev', description: 'Assemble dev team for a task' },
      { command: 'text', description: 'Toggle text-only / voice mirror mode' },
      {
        command: 'model',
        description: 'Switch AI model (sonnet/opus/haiku/ollama)',
      },
    ];
    this.bot.api
      .setMyCommands(defaultCommands)
      .catch((err) =>
        logger.warn({ err }, 'Failed to set Telegram bot commands'),
      );

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async sendVoice(jid: string, audioPath: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendVoice(
        numericId,
        new InputFile(audioPath, 'voice.ogg'),
      );
      logger.info({ jid }, 'Telegram voice message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram voice message');
    }
  }

  async sendDocument(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const fileName = path.basename(filePath);
      await this.bot.api.sendDocument(
        numericId,
        new InputFile(filePath, fileName),
        caption ? { caption } : undefined,
      );
      logger.info({ jid, fileName }, 'Telegram document sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram document');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
