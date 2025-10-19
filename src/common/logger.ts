export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  BUY = 4,
  SELL = 5,
}

export interface LogMessage {
  level: LogLevel;
  timestamp: Date;
  message: string;
  data?: unknown;
}

export interface LogTransport {
  name: string;
  minLevel: LogLevel;
  log(message: LogMessage): Promise<void> | void;
}

const COLORS = {
  reset: '\x1b[0m',
  // Background colors with text colors for contrast
  debug: '\x1b[46m\x1b[30m', // Cyan background, black text
  info: '\x1b[44m\x1b[37m', // Blue background, white text
  warn: '\x1b[43m\x1b[30m', // Yellow background, black text
  error: '\x1b[41m\x1b[37m', // Red background, white text
  buy: '\x1b[42m\x1b[30m', // Green background, black text
  sell: '\x1b[41m\x1b[37m', // Red background, white text
};

class ConsoleTransport implements LogTransport {
  name = 'console';
  minLevel = LogLevel.DEBUG;

  log(msg: LogMessage): void {
    const levelName = LogLevel[msg.level];

    let coloredLevel: string;
    switch (msg.level) {
      case LogLevel.ERROR:
        coloredLevel = `${COLORS.error}${levelName}${COLORS.reset}`;
        break;
      case LogLevel.WARN:
        coloredLevel = `${COLORS.warn}${levelName}${COLORS.reset}`;
        break;
      case LogLevel.INFO:
        coloredLevel = `${COLORS.info}${levelName}${COLORS.reset}`;
        break;
      case LogLevel.DEBUG:
        coloredLevel = `${COLORS.debug}${levelName}${COLORS.reset}`;
        break;
      case LogLevel.BUY:
        coloredLevel = `${COLORS.buy}${levelName}${COLORS.reset}`;
        break;
      case LogLevel.SELL:
        coloredLevel = `${COLORS.sell}${levelName}${COLORS.reset}`;
        break;
      default:
        coloredLevel = levelName;
    }

    const prefix = coloredLevel;

    switch (msg.level) {
      case LogLevel.ERROR:
        console.error(prefix, msg.message, msg.data || '');
        break;
      case LogLevel.WARN:
        console.warn(prefix, msg.message, msg.data || '');
        break;
      case LogLevel.INFO:
        console.info(prefix, msg.message, msg.data || '');
        break;
      case LogLevel.DEBUG:
        console.debug(prefix, msg.message, msg.data || '');
        break;
      case LogLevel.BUY:
      case LogLevel.SELL:
        console.log(prefix, msg.message, msg.data || '');
        break;
    }
  }
}

export interface TelegramTransportOptions {
  botToken: string;
  chatId: string;
  minLevel?: LogLevel;
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  disableNotification?: boolean;
}

export class TelegramTransport implements LogTransport {
  name = 'telegram';
  minLevel: LogLevel;
  private readonly apiUrl: string;
  private readonly parseMode: string;
  private readonly disableNotification: boolean;
  private readonly maxMessageLength = 4096; // Telegram message limit

  constructor(private options: TelegramTransportOptions) {
    this.minLevel = options.minLevel ?? LogLevel.WARN;
    this.apiUrl = `https://api.telegram.org/bot${options.botToken}/sendMessage`;
    this.parseMode = options.parseMode ?? 'HTML';
    this.disableNotification = options.disableNotification ?? false;
  }

  private getEmoji(level: LogLevel): string {
    switch (level) {
      case LogLevel.ERROR:
        return '🔴';
      case LogLevel.WARN:
        return '🟡';
      case LogLevel.INFO:
        return '🔵';
      case LogLevel.DEBUG:
        return '⚪️';
      case LogLevel.BUY:
        return '🟢';
      case LogLevel.SELL:
        return '🔴';
      default:
        return '⚫️';
    }
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private formatMessage(msg: LogMessage): string {
    const emoji = this.getEmoji(msg.level);
    const levelName = LogLevel[msg.level];
    const timestamp = msg.timestamp.toLocaleString('ru-RU', {
      timeZone: 'Europe/Warsaw',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    let formattedMsg = '';

    if (this.parseMode === 'HTML') {
      formattedMsg = `${emoji} <b>${levelName}</b>\n`;
      formattedMsg += `<i>${timestamp}</i>\n\n`;
      formattedMsg += `${this.escapeHtml(msg.message)}`;

      if (msg.data) {
        const dataStr = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data, null, 2);
        formattedMsg += `\n\n<pre>${this.escapeHtml(dataStr)}</pre>`;
      }
    } else {
      // Plain text fallback
      formattedMsg = `${emoji} ${levelName}\n`;
      formattedMsg += `${timestamp}\n\n`;
      formattedMsg += msg.message;

      if (msg.data) {
        const dataStr = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data, null, 2);
        formattedMsg += `\n\n${dataStr}`;
      }
    }

    // Truncate if message is too long
    if (formattedMsg.length > this.maxMessageLength) {
      const truncateMsg = '\n\n... (сообщение обрезано)';
      formattedMsg = formattedMsg.substring(0, this.maxMessageLength - truncateMsg.length) + truncateMsg;
    }

    return formattedMsg;
  }

  async log(msg: LogMessage): Promise<void> {
    try {
      const text = this.formatMessage(msg);

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: this.options.chatId,
          text,
          parse_mode: this.parseMode,
          disable_notification: this.disableNotification,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Failed to send message to Telegram:', error);
      }
    } catch (error) {
      console.error('Error sending message to Telegram:', error);
    }
  }
}

class Logger {
  private transports: LogTransport[] = [];
  private minLevel: LogLevel = LogLevel.INFO;

  constructor() {
    this.addTransport(new ConsoleTransport());

    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      this.addTransport(
        new TelegramTransport({
          botToken: process.env.TELEGRAM_BOT_TOKEN,
          chatId: process.env.TELEGRAM_CHAT_ID,
          minLevel: LogLevel.INFO,
        }),
      );
    }
  }

  addTransport(transport: LogTransport): void {
    this.transports.push(transport);
  }

  removeTransport(name: string): void {
    this.transports = this.transports.filter((t) => t.name !== name);
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private async logMessage(level: LogLevel, message: string, data?: unknown): Promise<void> {
    if (level < this.minLevel) {
      return; // Skip if below minimum level
    }

    const logMsg: LogMessage = {
      level,
      timestamp: new Date(),
      message,
      data,
    };

    // Send to all transports that accept this level
    const promises = this.transports
      .filter((transport) => level >= transport.minLevel)
      .map((transport) => Promise.resolve(transport.log(logMsg)));

    await Promise.allSettled(promises);
  }

  debug(message: string, data?: unknown): void {
    this.logMessage(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: unknown): void {
    this.logMessage(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: unknown): void {
    this.logMessage(LogLevel.WARN, message, data);
  }

  error(message: string, data?: unknown): void {
    this.logMessage(LogLevel.ERROR, message, data);
  }

  buy(message: string, data?: unknown): void {
    this.logMessage(LogLevel.BUY, message, data);
  }

  sell(message: string, data?: unknown): void {
    this.logMessage(LogLevel.SELL, message, data);
  }
}

export const logger = new Logger();
export { Logger };
