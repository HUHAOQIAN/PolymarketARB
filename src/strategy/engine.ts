import { CONFIG } from '../config';
import { NOAAFetcher } from '../data/noaa-fetcher';
import { PolymarketClient } from '../data/polymarket-client';
import { LiquidityAnalyzer } from './liquidity-analyzer';
import {
  WeatherForecast,
  ForecastPeriod,
  PolymarketMarket,
  TradingSignal,
  ProbabilityEstimate,
  RangeProbability,
} from '../types';
import { logger } from '../utils/logger';

/**
 * Core strategy engine.
 *
 * 1. Converts NOAA point forecasts into interval probabilities using a normal
 *    distribution model (with confidence-adjusted sigma).
 * 2. Compares estimated probabilities to Polymarket prices to find edge.
 * 3. Uses the Kelly Criterion (quarter Kelly) to size bets.
 */
export class StrategyEngine {
  private noaa: NOAAFetcher;
  private polymarket: PolymarketClient;
  private liquidityAnalyzer: LiquidityAnalyzer;

  constructor(noaa: NOAAFetcher, polymarket: PolymarketClient) {
    this.noaa = noaa;
    this.polymarket = polymarket;
    this.liquidityAnalyzer = new LiquidityAnalyzer(polymarket);
  }

  /**
   * Run the full strategy pipeline for a city:
   *   forecast → market scan → probability estimate → signal generation
   */
  async generateSignals(cityKey: string): Promise<TradingSignal[]> {
    logger.info(`Generating signals for ${cityKey}`);

    // 1. Get NOAA forecast
    const forecast = await this.noaa.getForecast(cityKey);
    const period = this.noaa.findRelevantPeriod(forecast);
    if (!period) {
      logger.info(`No relevant daytime forecast period found for ${cityKey}`);
      return [];
    }

    logger.info(
      `${cityKey} forecast: ${period.name} = ${period.temperature}°${period.temperatureUnit}, ` +
        `${period.hoursAhead}h ahead — "${period.shortForecast}"`,
    );

    // 2. Find active weather markets
    const markets = await this.polymarket.findWeatherMarkets(cityKey);
    if (markets.length === 0) {
      logger.info(`No active weather markets found for ${cityKey}`);
      return [];
    }

    // 3. Estimate probabilities
    const sigma = this.noaa.getSigmaForHoursAhead(period.hoursAhead);
    const confidence = this.estimateConfidence(period);
    const estimate = this.estimateProbabilities(
      period.temperature,
      sigma,
      confidence,
      markets,
    );

    // 4. Generate signals where we have edge
    const signals: TradingSignal[] = [];

    for (const market of markets) {
      if (!market.temperatureRange) continue;

      const rangeLow = market.temperatureRange.low;
      const rangeHigh = market.temperatureRange.high;

      // Find our probability estimate for this range
      const rangeProbEntry = estimate.rangeProbabilities.find(
        (rp) => rp.low === rangeLow && rp.high === rangeHigh,
      );
      const estimatedProb = rangeProbEntry?.probability ?? this.computeRangeProbability(
        period.temperature, estimate.sigma, rangeLow, rangeHigh,
      );

      // Check each outcome token
      for (const token of market.tokens) {
        const marketPrice = token.price;
        if (marketPrice <= 0 || marketPrice >= CONFIG.trading.maxMarketPrice) continue;

        // We look for YES tokens that are underpriced
        const isYesToken = token.outcome.toLowerCase() === 'yes' || token.outcome === market.outcomes[0];
        const effectiveProb = isYesToken ? estimatedProb : 1 - estimatedProb;
        const edge = effectiveProb - marketPrice;

        if (edge < CONFIG.trading.minEdge) continue;

        // Kelly sizing
        const odds = (1 / marketPrice) - 1;
        const kellyFull = (effectiveProb * odds - (1 - effectiveProb)) / odds;
        const kellyFraction = Math.max(0, kellyFull * CONFIG.trading.kellyMultiplier);
        const suggestedBet = Math.min(
          CONFIG.trading.bankroll * kellyFraction,
          CONFIG.trading.maxBetSize,
        );

        // Expected value
        const ev = effectiveProb * (1 / marketPrice - 1) * suggestedBet - (1 - effectiveProb) * suggestedBet;

        if (ev < CONFIG.trading.minExpectedValue) continue;

        // Liquidity check
        const liquidityOk = await this.liquidityAnalyzer.checkLiquidity(
          token.tokenId, marketPrice, suggestedBet,
        );
        const adjustedBet = liquidityOk.adjustedSize;

        if (adjustedBet <= 0) {
          logger.debug(`Skipping ${market.question} — insufficient liquidity`);
          continue;
        }

        const signal: TradingSignal = {
          city: cityKey,
          market,
          targetOutcome: token,
          estimatedProbability: effectiveProb,
          marketPrice,
          edge,
          kellyFraction,
          suggestedBetSize: adjustedBet,
          expectedValue: ev,
          forecast: period,
          confidence,
          hoursToResolution: period.hoursAhead,
          timestamp: new Date(),
        };

        signals.push(signal);

        logger.info(
          `SIGNAL: ${cityKey} "${market.question}" ` +
            `[${token.outcome}] est=${(effectiveProb * 100).toFixed(1)}% ` +
            `mkt=${(marketPrice * 100).toFixed(1)}% ` +
            `edge=${(edge * 100).toFixed(1)}% ` +
            `bet=$${adjustedBet.toFixed(2)}`,
        );
      }
    }

    // Sort by edge descending — best opportunities first
    signals.sort((a, b) => b.edge - a.edge);
    return signals;
  }

  // ============================================================
  // Probability estimation
  // ============================================================

  /**
   * Estimate probabilities for all temperature ranges in the given markets.
   */
  estimateProbabilities(
    forecastTemp: number,
    baseSigma: number,
    confidence: number,
    markets: PolymarketMarket[],
  ): ProbabilityEstimate {
    // Adjust sigma by confidence: lower confidence → wider distribution
    const sigma = baseSigma * (1.5 - confidence);

    const rangeProbabilities: RangeProbability[] = [];

    for (const market of markets) {
      if (!market.temperatureRange) continue;
      const { low, high } = market.temperatureRange;
      const prob = this.computeRangeProbability(forecastTemp, sigma, low, high);
      rangeProbabilities.push({ low, high, probability: prob });
    }

    return { rangeProbabilities, forecastTemp, sigma, confidence };
  }

  /**
   * P(low ≤ T < high) where T ~ N(mu, sigma²).
   * Uses the cumulative distribution function of the normal distribution.
   */
  computeRangeProbability(mu: number, sigma: number, low: number, high: number): number {
    if (sigma <= 0) return (mu >= low && mu < high) ? 1 : 0;
    const pHigh = high >= 200 ? 1 : this.normalCDF((high - mu) / sigma);
    const pLow = low <= -100 ? 0 : this.normalCDF((low - mu) / sigma);
    return Math.max(0, Math.min(1, pHigh - pLow));
  }

  /**
   * Estimate forecast confidence (0-1) based on conditions.
   */
  private estimateConfidence(period: ForecastPeriod): number {
    let confidence = 0.90; // Base confidence for NOAA 24h forecast

    // Degrade confidence for further-out forecasts
    if (period.hoursAhead > 24) confidence -= 0.05;
    if (period.hoursAhead > 48) confidence -= 0.05;
    if (period.hoursAhead > 72) confidence -= 0.10;

    // Degrade for severe weather (harder to predict)
    const severeKeywords = ['storm', 'hurricane', 'blizzard', 'tornado', 'severe', 'ice'];
    const desc = (period.shortForecast + ' ' + period.detailedForecast).toLowerCase();
    if (severeKeywords.some((kw) => desc.includes(kw))) {
      confidence -= 0.10;
    }

    // Degrade for high wind variability
    const windMatch = period.windSpeed.match(/(\d+)\s*to\s*(\d+)/);
    if (windMatch) {
      const windRange = parseInt(windMatch[2]) - parseInt(windMatch[1]);
      if (windRange > 15) confidence -= 0.05;
    }

    return Math.max(0.50, Math.min(0.95, confidence));
  }

  // ============================================================
  // Math helpers
  // ============================================================

  /**
   * Standard normal CDF approximation (Abramowitz & Stegun).
   * Accurate to ~1.5e-7.
   */
  private normalCDF(x: number): number {
    if (x < -8) return 0;
    if (x > 8) return 1;

    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.SQRT2;

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }
}
