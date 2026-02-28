import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';
import {
  RiskState,
  RiskLimits,
  TradeRecord,
  TradingSignal,
  OrderResult,
} from '../types';
import { logger } from '../utils/logger';

/**
 * Risk manager responsible for:
 *  - Enforcing position limits (max exposure, daily loss, consecutive losses)
 *  - Recording trades and settlements
 *  - Pausing trading when risk thresholds are breached
 *  - Persisting state to disk for crash recovery
 */
export class RiskManager {
  private state: RiskState;
  private limits: RiskLimits;

  constructor() {
    this.limits = CONFIG.risk;
    this.state = this.loadState();
    this.resetDailyCountersIfNeeded();
  }

  // ============================================================
  // Pre-trade checks
  // ============================================================

  /**
   * Check whether a proposed trade passes all risk rules.
   * Returns { allowed, reason }.
   */
  checkTradeAllowed(signal: TradingSignal): { allowed: boolean; reason?: string } {
    // Paused?
    if (this.state.isPaused) {
      if (this.state.pauseUntil && new Date() > this.state.pauseUntil) {
        this.resume();
      } else {
        return { allowed: false, reason: `Trading paused: ${this.state.pauseReason}` };
      }
    }

    // Daily trade count
    if (this.state.dailyTradeCount >= this.limits.maxDailyTrades) {
      return { allowed: false, reason: `Daily trade limit reached (${this.limits.maxDailyTrades})` };
    }

    // Daily loss
    if (this.state.dailyPnl <= -this.limits.maxDailyLoss) {
      this.pause(`Daily loss limit hit: $${Math.abs(this.state.dailyPnl).toFixed(2)}`, this.limits.cooldownMinutes);
      return { allowed: false, reason: 'Daily loss limit reached' };
    }

    // Total exposure
    const newExposure = this.state.totalExposure + signal.suggestedBetSize;
    if (newExposure > this.limits.maxTotalExposure) {
      return {
        allowed: false,
        reason: `Would exceed max exposure: $${newExposure.toFixed(2)} > $${this.limits.maxTotalExposure}`,
      };
    }

    // Single bet size
    if (signal.suggestedBetSize > this.limits.maxSingleBet) {
      return {
        allowed: false,
        reason: `Bet $${signal.suggestedBetSize.toFixed(2)} exceeds max single bet $${this.limits.maxSingleBet}`,
      };
    }

    // Consecutive losses
    if (this.state.consecutiveLosses >= this.limits.maxConsecutiveLosses) {
      this.pause(
        `${this.state.consecutiveLosses} consecutive losses`,
        this.limits.cooldownMinutes,
      );
      return { allowed: false, reason: 'Too many consecutive losses — paused' };
    }

    // Cooldown between trades
    if (this.state.lastTradeTime) {
      const elapsed = (Date.now() - this.state.lastTradeTime.getTime()) / 60_000;
      if (elapsed < 1) {
        return { allowed: false, reason: 'Cooldown: too soon since last trade' };
      }
    }

    return { allowed: true };
  }

  // ============================================================
  // Trade recording
  // ============================================================

  /**
   * Record a new trade after execution.
   */
  recordTrade(signal: TradingSignal, result: OrderResult): TradeRecord {
    const trade: TradeRecord = {
      id: result.orderId ?? `trade_${Date.now()}`,
      timestamp: new Date(),
      city: signal.city,
      marketId: signal.market.id,
      tokenId: signal.targetOutcome.tokenId,
      outcome: signal.targetOutcome.outcome,
      side: 'BUY',
      price: result.filledPrice ?? signal.marketPrice,
      size: result.filledSize ?? signal.suggestedBetSize,
      cost: (result.filledPrice ?? signal.marketPrice) * (result.filledSize ?? signal.suggestedBetSize),
      estimatedProbability: signal.estimatedProbability,
      edge: signal.edge,
      status: 'pending',
    };

    this.state.trades.push(trade);
    this.state.totalExposure += trade.cost;
    this.state.dailyTradeCount += 1;
    this.state.lastTradeTime = new Date();

    this.saveState();

    logger.info(
      `Trade recorded: ${trade.id} — ${trade.city} ${trade.outcome} ` +
        `${trade.size}@${trade.price.toFixed(4)} cost=$${trade.cost.toFixed(2)}`,
    );

    return trade;
  }

  /**
   * Record a market settlement (win or loss).
   */
  recordSettlement(tradeId: string, won: boolean): void {
    const trade = this.state.trades.find((t) => t.id === tradeId);
    if (!trade) {
      logger.warn(`Trade ${tradeId} not found for settlement`);
      return;
    }

    if (won) {
      // Win: payout = size * (1/price) - cost = size * (1 - price) / price
      trade.pnl = trade.size * (1 - trade.price);
      trade.status = 'settled_win';
      this.state.consecutiveLosses = 0;
    } else {
      trade.pnl = -trade.cost;
      trade.status = 'settled_loss';
      this.state.consecutiveLosses += 1;
    }

    trade.settledAt = new Date();
    this.state.dailyPnl += trade.pnl;
    this.state.totalExposure = Math.max(0, this.state.totalExposure - trade.cost);

    this.saveState();

    logger.info(
      `Settlement: ${tradeId} ${won ? 'WIN' : 'LOSS'} PnL=$${trade.pnl.toFixed(2)} ` +
        `(daily: $${this.state.dailyPnl.toFixed(2)})`,
    );
  }

  // ============================================================
  // Pause / Resume
  // ============================================================

  pause(reason: string, cooldownMinutes?: number): void {
    this.state.isPaused = true;
    this.state.pauseReason = reason;
    if (cooldownMinutes) {
      this.state.pauseUntil = new Date(Date.now() + cooldownMinutes * 60_000);
    }
    this.saveState();
    logger.warn(`Trading PAUSED: ${reason}`);
  }

  resume(): void {
    this.state.isPaused = false;
    this.state.pauseReason = undefined;
    this.state.pauseUntil = undefined;
    this.saveState();
    logger.info('Trading RESUMED');
  }

  // ============================================================
  // State accessors
  // ============================================================

  getState(): Readonly<RiskState> {
    return this.state;
  }

  getPendingTrades(): TradeRecord[] {
    return this.state.trades.filter((t) => t.status === 'pending');
  }

  getRecentTrades(n = 10): TradeRecord[] {
    return this.state.trades.slice(-n);
  }

  getDailySummary(): {
    trades: number;
    wins: number;
    losses: number;
    pnl: number;
    exposure: number;
  } {
    const today = new Date().toISOString().slice(0, 10);
    const todayTrades = this.state.trades.filter(
      (t) => t.timestamp.toISOString?.()?.slice(0, 10) === today ||
        (typeof t.timestamp === 'string' && (t.timestamp as string).slice(0, 10) === today),
    );
    const wins = todayTrades.filter((t) => t.status === 'settled_win').length;
    const losses = todayTrades.filter((t) => t.status === 'settled_loss').length;

    return {
      trades: this.state.dailyTradeCount,
      wins,
      losses,
      pnl: this.state.dailyPnl,
      exposure: this.state.totalExposure,
    };
  }

  // ============================================================
  // Persistence
  // ============================================================

  private loadState(): RiskState {
    try {
      if (fs.existsSync(CONFIG.paths.stateFile)) {
        const raw = fs.readFileSync(CONFIG.paths.stateFile, 'utf-8');
        const parsed = JSON.parse(raw);
        // Restore Date objects
        if (parsed.lastTradeTime) parsed.lastTradeTime = new Date(parsed.lastTradeTime);
        if (parsed.pauseUntil) parsed.pauseUntil = new Date(parsed.pauseUntil);
        parsed.trades = (parsed.trades ?? []).map((t: Record<string, unknown>) => ({
          ...t,
          timestamp: new Date(t.timestamp as string),
          settledAt: t.settledAt ? new Date(t.settledAt as string) : undefined,
        }));
        logger.info('Loaded risk state from disk', { trades: parsed.trades.length });
        return parsed as RiskState;
      }
    } catch (err) {
      logger.warn('Could not load risk state, starting fresh', { error: (err as Error).message });
    }

    return this.defaultState();
  }

  private saveState(): void {
    try {
      const dir = path.dirname(CONFIG.paths.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG.paths.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      logger.error('Failed to save risk state', { error: (err as Error).message });
    }
  }

  private defaultState(): RiskState {
    return {
      totalExposure: 0,
      dailyPnl: 0,
      dailyTradeCount: 0,
      consecutiveLosses: 0,
      isPaused: false,
      trades: [],
    };
  }

  private resetDailyCountersIfNeeded(): void {
    const lastTrade = this.state.lastTradeTime;
    if (!lastTrade) return;

    const lastDay = new Date(lastTrade).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (lastDay !== today) {
      logger.info('New day — resetting daily counters');
      this.state.dailyPnl = 0;
      this.state.dailyTradeCount = 0;
      this.saveState();
    }
  }
}
