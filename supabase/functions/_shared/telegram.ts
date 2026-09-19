/** Minimal Telegram Bot API client. Uses plain fetch so this module has no
 * Deno-specific imports and is unit-testable under Node. The bot token is
 * always passed in by the caller (from a Supabase Function secret) -- never
 * hardcoded or read from a global here. */

export interface InlineKeyboardButton { text: string; callback_data?: string; url?: string }
export type InlineKeyboard = InlineKeyboardButton[][];

export interface TelegramApiError extends Error {
  telegramDescription?: string;
  telegramErrorCode?: number;
}

function apiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

async function call<T>(botToken: string, method: string, body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(apiUrl(botToken, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!payload.ok) {
    const error = new Error(`Telegram ${method} failed: ${payload.description || response.status}`) as TelegramApiError;
    error.telegramDescription = payload.description;
    error.telegramErrorCode = payload.error_code;
    throw error;
  }
  return payload.result as T;
}

export interface TelegramClientOptions {
  botToken: string;
  fetchImpl?: typeof fetch;
}

export class TelegramClient {
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor({ botToken, fetchImpl = fetch }: TelegramClientOptions) {
    if (!botToken) throw new Error("TelegramClient requires a bot token.");
    this.botToken = botToken;
    this.fetchImpl = fetchImpl;
  }

  sendMessage(chatId: number | string, text: string, options: { replyMarkup?: InlineKeyboard; parseMode?: string } = {}) {
    return call<{ message_id: number }>(this.botToken, "sendMessage", {
      chat_id: chatId,
      text: text.slice(0, 4096),
      parse_mode: options.parseMode,
      reply_markup: options.replyMarkup ? { inline_keyboard: options.replyMarkup } : undefined,
    }, this.fetchImpl);
  }

  editMessageText(chatId: number | string, messageId: number, text: string, options: { replyMarkup?: InlineKeyboard; parseMode?: string } = {}) {
    return call<{ message_id: number } | true>(this.botToken, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, 4096),
      parse_mode: options.parseMode,
      reply_markup: options.replyMarkup ? { inline_keyboard: options.replyMarkup } : undefined,
    }, this.fetchImpl);
  }

  answerCallbackQuery(callbackQueryId: string, options: { text?: string; showAlert?: boolean } = {}) {
    return call<true>(this.botToken, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: options.text,
      show_alert: options.showAlert,
    }, this.fetchImpl);
  }
}
