import axios from 'axios';
import { CONFIG } from '../config';
import { NotificationPayload, TradingSignal, TradeRecord } from '../types';
import { logger } from '../utils/logger';

/**
 * Telegram notification service.
 * Sends trade alerts, daily reports, and risk warnings.
 */
export class TelegramNotifier {
  private enabled: boolean;
  private apiUrl: string;
  private chatId: string;

  constructor() {
    this.enabled = !!(CONFIG.telegram.botToken && CONFIG.telegram.chatId);
    this.apiUrl = `https://api.telegram.org/bot${CONFIG.telegram.botToken}`;
    this.chatId = CONFIG.telegram.chatId;

    if (!this.enabled) {
      logger.info('Telegram notifications disabled (no bot token / chat ID configured)');
    }
  }

  /**
   * Send a raw notification.
   */
  async send(payload: NotificationPayload): Promise<void> {
    if (!this.enabled) {
      logger.debug(`[Telegram OFF] ${payload.title}: ${payload.message}`);
      return;
    }

    const icon = this.getIcon(payload.type);
    const text = `${icon} *${this.escapeMarkdown(payload.title)}*\n\n${this.escapeMarkdown(payload.message)}`;

    await this.sendMessage(text);
  }

  /**
   * Notify about a new trading signal.
   */
  async notifySignal(signal: TradingSignal): Promise<void> {
    const msg = [
      `City: ${signal.city}`,
      `Market: ${signal.market.question}`,
      `Outcome: ${signal.targetOutcome.outcome}`,
      `Est. Prob: ${(signal.estimatedProbability * 100).toFixed(1)}%`,
      `Mkt Price: ${(signal.marketPrice * 100).toFixed(1)}%`,
      `Edge: ${(signal.edge * 100).toFixed(1)}%`,
      `Bet Size: $${signal.suggestedBetSize.toFixed(2)}`,
      `EV: $${signal.expectedValue.toFixed(2)}`,
      `Forecast: ${signal.forecast.temperature}°${signal.forecast.temperatureUnit}`,
      `Hours to resolution: ${signal.hoursToResolution}h`,
    ].join('\n');

    await this.send({ type: 'signal', title: 'New Trading Signal', message: msg });
  }

  /**
   * Notify about an executed trade.
   */
  async notifyTrade(trade: TradeRecord, dryRun: boolean): Promise<void> {
    const prefix = dryRun ? '[DRY RUN] ' : '';
    const msg = [
      `${prefix}${trade.side} ${trade.outcome}`,
      `City: ${trade.city}`,
      `Price: ${trade.price.toFixed(4)}`,
      `Size: ${trade.size.toFixed(2)}`,
      `Cost: $${trade.cost.toFixed(2)}`,
      `Edge: ${(trade.edge * 100).toFixed(1)}%`,
    ].join('\n');

    await this.send({ type: 'trade', title: `${prefix}Trade Executed`, message: msg });
  }

  /**
   * Notify about a settlement.
   */
  async notifySettlement(trade: TradeRecord): Promise<void> {
    const won = trade.status === 'settled_win';
    const result = won ? 'WIN' : 'LOSS';
    const msg = [
      `Result: ${result}`,
      `City: ${trade.city}`,
      `Outcome: ${trade.outcome}`,
      `PnL: $${(trade.pnl ?? 0).toFixed(2)}`,
    ].join('\n');

    await this.send({ type: 'settlement', title: `Settlement: ${result}`, message: msg });
  }

  /**
   * Send a daily performance report.
   */
  async sendDailyReport(summary: {
    trades: number;
    wins: number;
    losses: number;
    pnl: number;
    exposure: number;
  }): Promise<void> {
    const msg = [
      `Date: ${new Date().toISOString().slice(0, 10)}`,
      `Trades: ${summary.trades}`,
      `Wins: ${summary.wins} | Losses: ${summary.losses}`,
      `Win Rate: ${summary.trades > 0 ? ((summary.wins / summary.trades) * 100).toFixed(1) : 0}%`,
      `Daily PnL: $${summary.pnl.toFixed(2)}`,
      `Exposure: $${summary.exposure.toFixed(2)}`,
    ].join('\n');

    await this.send({ type: 'daily_report', title: 'Daily Report', message: msg });
  }

  /**
   * Send a risk alert.
   */
  async sendRiskAlert(reason: string): Promise<void> {
    await this.send({ type: 'risk_alert', title: 'RISK ALERT', message: reason });
  }

  // --- Private helpers ---

  private async sendMessage(text: string): Promise<void> {
    try {
      await axios.post(`${this.apiUrl}/sendMessage`, {
        chat_id: this.chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    } catch (err) {
      logger.error('Failed to send Telegram message', { error: (err as Error).message });
    }
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
  }

  private getIcon(type: NotificationPayload['type']): string {
    const icons: Record<string, string> = {
      signal: '[SIGNAL]',
      trade: '[TRADE]',
      settlement: '[SETTLE]',
      error: '[ERROR]',
      daily_report: '[REPORT]',
      risk_alert: '[RISK]',
    };
    return icons[type] ?? '';
  }
}
