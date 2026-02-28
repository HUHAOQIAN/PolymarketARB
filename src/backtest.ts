/**
 * Backtest engine.
 *
 * Simulates the strategy against historical (or synthetic) data to validate
 * the probability model and Kelly sizing before going live.
 *
 * Usage:  npm run backtest
 */

import { CONFIG, CITIES } from './config';
import { BacktestResult, TradeRecord } from './types';
import { logger } from './utils/logger';

// ============================================================
// Normal CDF (same as in StrategyEngine — duplicated to keep
// the backtest self-contained without importing the full engine)
// ============================================================

function normalCDF(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

function rangeProbability(mu: number, sigma: number, low: number, high: number): number {
  return normalCDF((high - mu) / sigma) - normalCDF((low - mu) / sigma);
}

// ============================================================
// Synthetic data generator
// ============================================================

interface SyntheticDay {
  date: Date;
  city: string;
  /** NOAA "forecast" temperature */
  forecastTemp: number;
  /** Actual observed temperature (simulated) */
  actualTemp: number;
  /** Market range [low, high) */
  rangeLow: number;
  rangeHigh: number;
  /** Market's implied probability (price) */
  marketPrice: number;
}

/**
 * Generate synthetic historical data for backtesting.
 *
 * For each city and each day:
 *  1. Pick a "true" temperature from a seasonal distribution.
 *  2. Generate a "forecast" = true + small bias + noise.
 *  3. Pick a market range that contains the true temperature.
 *  4. Generate a "market price" that is noisier (represents retail crowd).
 */
function generateSyntheticData(days: number): SyntheticDay[] {
  const data: SyntheticDay[] = [];
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const cityKeys = Object.keys(CITIES);

  for (let d = 0; d < days; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const dayOfYear = Math.floor(
      (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000,
    );

    for (const cityKey of cityKeys) {
      // Seasonal base temperature (°F) — rough sine wave
      const seasonalBase = 55 + 25 * Math.sin(((dayOfYear - 80) / 365) * 2 * Math.PI);

      // City offset
      const cityOffsets: Record<string, number> = {
        NYC: 0, LAX: 15, CHI: -5, MIA: 20, DEN: -8,
      };
      const offset = cityOffsets[cityKey] ?? 0;

      // True temperature with daily variability
      const trueTemp = Math.round(seasonalBase + offset + gaussRandom() * 5);

      // NOAA forecast (biased slightly, small error)
      const forecastError = gaussRandom() * 3; // σ ≈ 3°F for 24h forecast
      const forecastTemp = Math.round(trueTemp + forecastError);

      // Market range: 5°F buckets centered near the true temp
      const bucketBase = Math.floor(trueTemp / 5) * 5;
      const rangeLow = bucketBase;
      const rangeHigh = bucketBase + 5;

      // True probability that trueTemp falls in range (based on forecast)
      const trueProbFromForecast = rangeProbability(forecastTemp, 3, rangeLow, rangeHigh);

      // Market price = true probability + noise (retail mispricing)
      const mispricing = (Math.random() - 0.5) * 0.4; // ±20% noise
      const marketPrice = Math.max(0.05, Math.min(0.95, trueProbFromForecast + mispricing));

      data.push({
        date,
        city: cityKey,
        forecastTemp,
        actualTemp: trueTemp,
        rangeLow,
        rangeHigh,
        marketPrice,
      });
    }
  }

  return data;
}

function gaussRandom(): number {
  // Box-Muller transform
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ============================================================
// Backtest runner
// ============================================================

function runBacktest(days = 90): BacktestResult {
  const data = generateSyntheticData(days);
  let bankroll = CONFIG.trading.bankroll;
  const initialBankroll = bankroll;
  const trades: TradeRecord[] = [];
  const bankrollHistory: { date: Date; value: number }[] = [];
  let maxBankroll = bankroll;
  let maxDrawdown = 0;

  logger.info(`Running backtest: ${days} days, ${data.length} data points, bankroll=$${bankroll}`);

  for (const day of data) {
    // Estimate probability using our model
    const sigma = CONFIG.forecastSigma.hours24;
    const confidence = 0.88;
    const sigmaAdj = sigma * (1.5 - confidence);
    const estProb = rangeProbability(day.forecastTemp, sigmaAdj, day.rangeLow, day.rangeHigh);

    // Calculate edge
    const edge = estProb - day.marketPrice;
    if (edge < CONFIG.trading.minEdge) continue;
    if (day.marketPrice >= CONFIG.trading.maxMarketPrice) continue;

    // Kelly sizing
    const odds = (1 / day.marketPrice) - 1;
    const kellyFull = (estProb * odds - (1 - estProb)) / odds;
    const kellyFraction = Math.max(0, kellyFull * CONFIG.trading.kellyMultiplier);
    const betSize = Math.min(bankroll * kellyFraction, CONFIG.trading.maxBetSize, bankroll * 0.1);

    if (betSize < 1) continue; // Skip tiny bets

    // Determine outcome: did actual temp fall in the range?
    const won = day.actualTemp >= day.rangeLow && day.actualTemp < day.rangeHigh;
    const pnl = won
      ? betSize * (1 / day.marketPrice - 1) // profit: payout - cost
      : -betSize; // loss: lose the bet

    bankroll += pnl;

    trades.push({
      id: `bt_${trades.length}`,
      timestamp: day.date,
      city: day.city,
      marketId: `${day.city}_${day.rangeLow}-${day.rangeHigh}`,
      tokenId: '',
      outcome: `${day.rangeLow}-${day.rangeHigh}°F`,
      side: 'BUY',
      price: day.marketPrice,
      size: betSize,
      cost: betSize,
      estimatedProbability: estProb,
      edge,
      status: won ? 'settled_win' : 'settled_loss',
      pnl,
      settledAt: day.date,
    });

    bankrollHistory.push({ date: day.date, value: bankroll });

    // Track drawdown
    maxBankroll = Math.max(maxBankroll, bankroll);
    const drawdown = (maxBankroll - bankroll) / maxBankroll;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  const wins = trades.filter((t) => t.status === 'settled_win').length;
  const losses = trades.filter((t) => t.status === 'settled_loss').length;
  const totalPnl = bankroll - initialBankroll;
  const avgEdge = trades.length > 0
    ? trades.reduce((sum, t) => sum + t.edge, 0) / trades.length
    : 0;
  const avgBetSize = trades.length > 0
    ? trades.reduce((sum, t) => sum + t.size, 0) / trades.length
    : 0;

  // Simplified Sharpe (daily returns)
  const dailyReturns: number[] = [];
  let prevValue = initialBankroll;
  for (const point of bankrollHistory) {
    dailyReturns.push((point.value - prevValue) / prevValue);
    prevValue = point.value;
  }
  const meanReturn = dailyReturns.length > 0
    ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
    : 0;
  const stdReturn = dailyReturns.length > 1
    ? Math.sqrt(
        dailyReturns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (dailyReturns.length - 1),
      )
    : 0;
  const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    totalPnl,
    maxDrawdown,
    sharpeRatio,
    avgEdge,
    avgBetSize,
    bankrollHistory,
    trades,
  };
}

// ============================================================
// Main
// ============================================================

function printResults(result: BacktestResult): void {
  console.log('\n========================================');
  console.log('       BACKTEST RESULTS (Synthetic)');
  console.log('========================================\n');
  console.log(`  Total Trades:     ${result.totalTrades}`);
  console.log(`  Wins:             ${result.wins}`);
  console.log(`  Losses:           ${result.losses}`);
  console.log(`  Win Rate:         ${(result.winRate * 100).toFixed(1)}%`);
  console.log(`  Total PnL:        $${result.totalPnl.toFixed(2)}`);
  console.log(`  Max Drawdown:     ${(result.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`  Sharpe Ratio:     ${result.sharpeRatio.toFixed(2)}`);
  console.log(`  Avg Edge:         ${(result.avgEdge * 100).toFixed(1)}%`);
  console.log(`  Avg Bet Size:     $${result.avgBetSize.toFixed(2)}`);
  console.log(`  Final Bankroll:   $${(CONFIG.trading.bankroll + result.totalPnl).toFixed(2)}`);
  console.log('\n========================================');

  // Per-city breakdown
  const cities = [...new Set(result.trades.map((t) => t.city))];
  console.log('\n  Per-City Breakdown:');
  for (const city of cities) {
    const cityTrades = result.trades.filter((t) => t.city === city);
    const cityWins = cityTrades.filter((t) => t.status === 'settled_win').length;
    const cityPnl = cityTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    console.log(
      `    ${city.padEnd(5)} — ${cityTrades.length} trades, ` +
        `${((cityWins / cityTrades.length) * 100).toFixed(0)}% win rate, ` +
        `PnL: $${cityPnl.toFixed(2)}`,
    );
  }

  console.log('\n========================================\n');
}

// Entry point
const result = runBacktest(90);
printResults(result);
