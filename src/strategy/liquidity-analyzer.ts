import { PolymarketClient } from '../data/polymarket-client';
import { OrderBook } from '../types';
import { logger } from '../utils/logger';

export interface LiquidityCheckResult {
  ok: boolean;
  adjustedSize: number;
  estimatedSlippage: number;
  depth: number;
  spread: number;
  reason?: string;
}

/**
 * Analyzes order book depth and estimates slippage before placing trades.
 */
export class LiquidityAnalyzer {
  /** Maximum acceptable slippage (2%) */
  private maxSlippage = 0.02;
  /** Maximum acceptable spread (5%) */
  private maxSpread = 0.05;
  /** Minimum depth we require at our price level (in USDC) */
  private minDepth = 10;

  private polymarket: PolymarketClient;

  constructor(polymarket: PolymarketClient) {
    this.polymarket = polymarket;
  }

  /**
   * Check whether there is enough liquidity to fill a given order.
   * Returns an adjusted size if the full size can't be absorbed without excessive slippage.
   */
  async checkLiquidity(
    tokenId: string,
    targetPrice: number,
    desiredSize: number,
  ): Promise<LiquidityCheckResult> {
    let book: OrderBook;
    try {
      book = await this.polymarket.getOrderBook(tokenId);
    } catch (err) {
      logger.warn(`Could not fetch order book for ${tokenId}`, { error: (err as Error).message });
      // On failure, allow a reduced trade rather than blocking entirely
      return {
        ok: true,
        adjustedSize: Math.min(desiredSize, 5),
        estimatedSlippage: 0,
        depth: 0,
        spread: 0,
        reason: 'Order book unavailable — using conservative size',
      };
    }

    // Check spread
    if (book.spread > this.maxSpread) {
      return {
        ok: false,
        adjustedSize: 0,
        estimatedSlippage: 0,
        depth: 0,
        spread: book.spread,
        reason: `Spread too wide: ${(book.spread * 100).toFixed(1)}%`,
      };
    }

    // Analyze ask side (we're buying)
    const askDepth = this.computeDepthAtPrice(book.asks, targetPrice);
    const { slippage, fillableSize } = this.estimateSlippage(book.asks, desiredSize);

    if (askDepth < this.minDepth) {
      return {
        ok: false,
        adjustedSize: 0,
        estimatedSlippage: slippage,
        depth: askDepth,
        spread: book.spread,
        reason: `Insufficient depth: $${askDepth.toFixed(2)} available`,
      };
    }

    if (slippage > this.maxSlippage) {
      // Reduce size to stay within slippage tolerance
      const reduced = this.findMaxSizeForSlippage(book.asks, this.maxSlippage);
      if (reduced <= 0) {
        return {
          ok: false,
          adjustedSize: 0,
          estimatedSlippage: slippage,
          depth: askDepth,
          spread: book.spread,
          reason: `Slippage too high: ${(slippage * 100).toFixed(1)}%`,
        };
      }

      return {
        ok: true,
        adjustedSize: Math.min(reduced, desiredSize),
        estimatedSlippage: this.maxSlippage,
        depth: askDepth,
        spread: book.spread,
        reason: `Size reduced from $${desiredSize.toFixed(2)} to $${reduced.toFixed(2)} for slippage`,
      };
    }

    return {
      ok: true,
      adjustedSize: Math.min(fillableSize, desiredSize),
      estimatedSlippage: slippage,
      depth: askDepth,
      spread: book.spread,
    };
  }

  /**
   * Total $ depth available at or below a target price on the ask side.
   */
  private computeDepthAtPrice(
    asks: { price: number; size: number }[],
    targetPrice: number,
  ): number {
    let depth = 0;
    for (const ask of asks) {
      if (ask.price <= targetPrice) {
        depth += ask.price * ask.size;
      }
    }
    return depth;
  }

  /**
   * Estimate the slippage of filling a given size against the asks.
   */
  private estimateSlippage(
    asks: { price: number; size: number }[],
    desiredSize: number,
  ): { slippage: number; fillableSize: number } {
    if (asks.length === 0) return { slippage: 1, fillableSize: 0 };

    const bestAsk = asks[0].price;
    let remaining = desiredSize;
    let totalCost = 0;
    let totalFilled = 0;

    for (const ask of asks) {
      if (remaining <= 0) break;
      const fillQty = Math.min(remaining / ask.price, ask.size);
      const cost = fillQty * ask.price;
      totalCost += cost;
      totalFilled += fillQty;
      remaining -= cost;
    }

    if (totalFilled === 0) return { slippage: 1, fillableSize: 0 };

    const avgPrice = totalCost / totalFilled;
    const slippage = (avgPrice - bestAsk) / bestAsk;

    return {
      slippage: Math.max(0, slippage),
      fillableSize: desiredSize - Math.max(0, remaining),
    };
  }

  /**
   * Binary search for the maximum $ size we can trade under a given slippage cap.
   */
  private findMaxSizeForSlippage(
    asks: { price: number; size: number }[],
    maxSlippage: number,
  ): number {
    let lo = 0;
    let hi = 0;
    // Sum all ask liquidity as upper bound
    for (const ask of asks) hi += ask.price * ask.size;

    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      const { slippage } = this.estimateSlippage(asks, mid);
      if (slippage <= maxSlippage) {
        lo = mid;
      } else {
        hi = mid;
      }
    }

    return Math.floor(lo * 100) / 100; // Round down to 2 decimal places
  }
}
