/**
 * Main entry point — Bot controller and scheduler.
 *
 * Lifecycle:
 *   1. Initialize all components
 *   2. Run an immediate scan cycle
 *   3. Start cron scheduler for periodic scans
 *   4. Handle graceful shutdown
 */

import { CronJob } from 'cron';
import { CONFIG, CITIES } from './config';
import { NOAAFetcher } from './data/noaa-fetcher';
import { PolymarketClient } from './data/polymarket-client';
import { StrategyEngine } from './strategy/engine';
import { RiskManager } from './execution/risk-manager';
import { TelegramNotifier } from './notification/telegram';
import { TradingSignal } from './types';
import { logger } from './utils/logger';

class WeatherArbBot {
  private noaa: NOAAFetcher;
  private polymarket: PolymarketClient;
  private strategy: StrategyEngine;
  private risk: RiskManager;
  private telegram: TelegramNotifier;
  private cronJob: CronJob | null = null;
  private running = false;

  constructor() {
    this.noaa = new NOAAFetcher();
    this.polymarket = new PolymarketClient();
    this.strategy = new StrategyEngine(this.noaa, this.polymarket);
    this.risk = new RiskManager();
    this.telegram = new TelegramNotifier();
  }

  /**
   * Bootstrap: init clients, run first scan, start scheduler.
   */
  async start(): Promise<void> {
    logger.info('=== Polymarket Weather Arbitrage Bot ===');
    logger.info(`Mode: ${CONFIG.trading.dryRun ? 'DRY RUN' : 'LIVE'}`);
    logger.info(`Bankroll: $${CONFIG.trading.bankroll}`);
    logger.info(`Max bet: $${CONFIG.trading.maxBetSize}`);
    logger.info(`Min edge: ${(CONFIG.trading.minEdge * 100).toFixed(0)}%`);
    logger.info(`Cities: ${Object.keys(CITIES).join(', ')}`);

    // Initialize CLOB client for live trading
    if (!CONFIG.trading.dryRun) {
      await this.polymarket.initClobClient();
    }

    // Register shutdown hooks
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));

    // Run first scan immediately
    await this.runCycle();

    // Start cron scheduler
    this.cronJob = new CronJob(
      CONFIG.trading.cronSchedule,
      () => this.runCycle(),
      null,
      true,
      'UTC',
    );

    logger.info(`Scheduler started: "${CONFIG.trading.cronSchedule}"`);
    await this.telegram.send({
      type: 'signal',
      title: 'Bot Started',
      message: `Mode: ${CONFIG.trading.dryRun ? 'DRY RUN' : 'LIVE'}\nCities: ${Object.keys(CITIES).join(', ')}`,
    });
  }

  /**
   * One full scan cycle: iterate cities → generate signals → execute trades.
   */
  async runCycle(): Promise<void> {
    if (this.running) {
      logger.warn('Previous cycle still running, skipping');
      return;
    }
    this.running = true;

    const cycleStart = Date.now();
    logger.info('--- Scan cycle started ---');

    let totalSignals = 0;
    let totalTrades = 0;

    for (const cityKey of Object.keys(CITIES)) {
      try {
        // Generate signals for this city
        const signals = await this.strategy.generateSignals(cityKey);
        totalSignals += signals.length;

        // Execute trades for viable signals
        for (const signal of signals) {
          const executed = await this.executeSignal(signal);
          if (executed) totalTrades++;
        }
      } catch (err) {
        logger.error(`Error processing ${cityKey}`, { error: (err as Error).message });
      }
    }

    // Check settlements for pending trades
    await this.checkSettlements();

    const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
    logger.info(
      `--- Scan cycle complete: ${totalSignals} signals, ${totalTrades} trades, ${elapsed}s ---`,
    );

    this.running = false;
  }

  /**
   * Evaluate and execute a single trading signal.
   */
  private async executeSignal(signal: TradingSignal): Promise<boolean> {
    // Risk check
    const riskCheck = this.risk.checkTradeAllowed(signal);
    if (!riskCheck.allowed) {
      logger.info(`Risk blocked: ${riskCheck.reason}`);
      return false;
    }

    // Notify
    await this.telegram.notifySignal(signal);

    // Execute trade
    const result = await this.polymarket.executeTrade(
      signal.targetOutcome.tokenId,
      signal.marketPrice,
      signal.suggestedBetSize,
      'BUY',
    );

    if (result.success) {
      const trade = this.risk.recordTrade(signal, result);
      await this.telegram.notifyTrade(trade, CONFIG.trading.dryRun);
      return true;
    }

    logger.warn(`Trade failed: ${result.message}`);
    return false;
  }

  /**
   * Check if any pending trades have settled.
   */
  private async checkSettlements(): Promise<void> {
    const pendingTrades = this.risk.getPendingTrades();
    if (pendingTrades.length === 0) return;

    logger.info(`Checking settlements for ${pendingTrades.length} pending trade(s)`);

    for (const trade of pendingTrades) {
      try {
        const market = await this.polymarket.getMarket(trade.marketId);
        if (!market || !market.closed) continue;

        // Market is settled — determine winner
        const winnerToken = market.tokens.find((t) => t.winner === true);
        const won = winnerToken?.tokenId === trade.tokenId;

        this.risk.recordSettlement(trade.id, won);
        await this.telegram.notifySettlement({
          ...trade,
          status: won ? 'settled_win' : 'settled_loss',
          pnl: won ? trade.size * (1 - trade.price) : -trade.cost,
        });
      } catch (err) {
        logger.debug(`Could not check settlement for ${trade.id}`, {
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Graceful shutdown.
   */
  private async shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down...`);

    if (this.cronJob) {
      this.cronJob.stop();
    }

    const summary = this.risk.getDailySummary();
    await this.telegram.sendDailyReport(summary);

    logger.info('Bot stopped');
    process.exit(0);
  }
}

// ============================================================
// Bootstrap
// ============================================================

async function main(): Promise<void> {
  try {
    const bot = new WeatherArbBot();
    await bot.start();
  } catch (err) {
    logger.error('Fatal error during startup', { error: (err as Error).message, stack: (err as Error).stack });
    process.exit(1);
  }
}

main();
