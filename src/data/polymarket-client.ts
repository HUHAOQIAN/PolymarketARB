import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { CONFIG, CITIES } from '../config';
import {
  PolymarketMarket,
  MarketToken,
  TemperatureRange,
  OrderBook,
  OrderBookEntry,
  OrderResult,
  Position,
} from '../types';
import { logger } from '../utils/logger';

/**
 * Polymarket client handling both Gamma API (market discovery) and CLOB API (trading).
 */
export class PolymarketClient {
  private gamma: AxiosInstance;
  private clob: AxiosInstance;
  private clobClient: unknown | null = null;
  private wallet: ethers.Wallet | null = null;
  private marketCache = new Map<string, { data: PolymarketMarket[]; expiry: number }>();

  constructor() {
    this.gamma = axios.create({
      baseURL: CONFIG.polymarket.gammaBaseUrl,
      timeout: 15_000,
    });

    this.clob = axios.create({
      baseURL: CONFIG.polymarket.clobBaseUrl,
      timeout: 15_000,
    });

    if (CONFIG.polymarket.privateKey) {
      this.wallet = new ethers.Wallet(CONFIG.polymarket.privateKey);
    }
  }

  /**
   * Initialize the CLOB client for live trading.
   * Dynamically imports @polymarket/clob-client to avoid errors when not installed.
   */
  async initClobClient(): Promise<void> {
    if (!CONFIG.polymarket.privateKey) {
      logger.warn('No private key configured, CLOB client not initialized (dry-run only)');
      return;
    }

    try {
      const { ClobClient } = await import('@polymarket/clob-client');
      const creds = CONFIG.polymarket.apiKey
        ? {
            key: CONFIG.polymarket.apiKey,
            secret: CONFIG.polymarket.apiSecret,
            passphrase: CONFIG.polymarket.apiPassphrase,
          }
        : undefined;
      this.clobClient = new ClobClient(
        CONFIG.polymarket.clobBaseUrl,
        CONFIG.polymarket.chainId as number,
        this.wallet!,
        creds,
      );
      logger.info('CLOB client initialized successfully');
    } catch (err) {
      logger.error('Failed to initialize CLOB client', { error: (err as Error).message });
      throw new Error(
        'Could not initialize CLOB client. Ensure @polymarket/clob-client is installed and credentials are correct.',
      );
    }
  }

  // ============================================================
  // Market Discovery (Gamma API)
  // ============================================================

  /**
   * Search for weather temperature markets on Polymarket.
   */
  async findWeatherMarkets(cityKey: string): Promise<PolymarketMarket[]> {
    const city = CITIES[cityKey];
    if (!city) throw new Error(`Unknown city: ${cityKey}`);

    // Check cache first
    const cacheKey = `weather_${cityKey}`;
    const cached = this.marketCache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      logger.debug(`Using cached markets for ${city.name} (${cached.data.length} markets)`);
      return cached.data;
    }

    const allMarkets: PolymarketMarket[] = [];

    for (const keyword of city.searchKeywords) {
      try {
        const markets = await this.searchMarkets(keyword);
        for (const m of markets) {
          // Deduplicate by ID
          if (!allMarkets.find((existing) => existing.id === m.id)) {
            allMarkets.push(m);
          }
        }
      } catch (err) {
        logger.warn(`Search failed for keyword "${keyword}"`, { error: (err as Error).message });
      }
    }

    // Also try tag-based search
    try {
      const tagMarkets = await this.searchByTag('weather');
      for (const m of tagMarkets) {
        // Filter to this city by checking question text
        const cityNames = [city.name, cityKey];
        const isRelevant = cityNames.some(
          (name) =>
            m.question.toLowerCase().includes(name.toLowerCase()) ||
            m.description.toLowerCase().includes(name.toLowerCase()),
        );
        if (isRelevant && !allMarkets.find((existing) => existing.id === m.id)) {
          allMarkets.push(m);
        }
      }
    } catch {
      // Tag search is optional
    }

    // Parse temperature ranges and filter active markets
    const weatherMarkets = allMarkets
      .filter((m) => m.active && !m.closed)
      .map((m) => {
        m.temperatureRange = this.parseTemperatureRange(m.question) ?? undefined;
        m.city = cityKey;
        return m;
      })
      .filter((m) => m.temperatureRange !== null);

    // Cache results
    this.marketCache.set(cacheKey, {
      data: weatherMarkets,
      expiry: Date.now() + CONFIG.polymarket.marketCacheTtlMinutes * 60 * 1000,
    });

    logger.info(`Found ${weatherMarkets.length} active weather markets for ${city.name}`);
    return weatherMarkets;
  }

  /**
   * Search Gamma API for markets matching a query.
   */
  private async searchMarkets(query: string, limit = 20, offset = 0): Promise<PolymarketMarket[]> {
    logger.debug(`Searching Gamma API: "${query}"`);
    const response = await this.gamma.get('/markets', {
      params: { active: true, closed: false, _q: query, limit, offset },
    });

    const rawMarkets = Array.isArray(response.data) ? response.data : response.data?.data ?? [];
    return rawMarkets.map((raw: Record<string, unknown>) => this.parseGammaMarket(raw));
  }

  /**
   * Search markets by tag.
   */
  private async searchByTag(tag: string): Promise<PolymarketMarket[]> {
    const response = await this.gamma.get('/markets', {
      params: { active: true, closed: false, tag, limit: 50 },
    });
    const rawMarkets = Array.isArray(response.data) ? response.data : response.data?.data ?? [];
    return rawMarkets.map((raw: Record<string, unknown>) => this.parseGammaMarket(raw));
  }

  /**
   * Get a single market by its condition ID.
   */
  async getMarket(marketId: string): Promise<PolymarketMarket | null> {
    try {
      const response = await this.gamma.get(`/markets/${marketId}`);
      return this.parseGammaMarket(response.data);
    } catch {
      return null;
    }
  }

  // ============================================================
  // Order Book & Pricing (CLOB API)
  // ============================================================

  /**
   * Get real-time order book for a token.
   */
  async getOrderBook(tokenId: string): Promise<OrderBook> {
    const response = await this.clob.get('/book', { params: { token_id: tokenId } });
    const data = response.data;

    const bids: OrderBookEntry[] = (data.bids ?? []).map(
      (b: Record<string, string>) => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size),
      }),
    );
    const asks: OrderBookEntry[] = (data.asks ?? []).map(
      (a: Record<string, string>) => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size),
      }),
    );

    // Sort: bids descending, asks ascending
    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 1;

    return {
      tokenId,
      bids,
      asks,
      spread: bestAsk - bestBid,
      midPrice: (bestBid + bestAsk) / 2,
      bestBid,
      bestAsk,
    };
  }

  /**
   * Get the latest mid-market price for a token.
   */
  async getPrice(tokenId: string): Promise<number> {
    try {
      const response = await this.clob.get('/price', {
        params: { token_id: tokenId, side: 'buy' },
      });
      return parseFloat(response.data?.price ?? '0');
    } catch {
      // Fallback to order book
      const book = await this.getOrderBook(tokenId);
      return book.midPrice;
    }
  }

  // ============================================================
  // Trading (CLOB API)
  // ============================================================

  /**
   * Execute a trade via CLOB API.
   * In dry-run mode, simulates the trade and returns a mock result.
   */
  async executeTrade(
    tokenId: string,
    price: number,
    size: number,
    side: 'BUY' | 'SELL' = 'BUY',
  ): Promise<OrderResult> {
    // --- Dry run ---
    if (CONFIG.trading.dryRun) {
      logger.info(`[DRY RUN] Would ${side} ${size} @ $${price.toFixed(4)} (token: ${tokenId})`);
      return {
        success: true,
        orderId: `dry_${Date.now()}`,
        filledSize: size,
        filledPrice: price,
        status: 'dry_run',
        message: 'Simulated trade in dry-run mode',
      };
    }

    // --- Live trading ---
    if (!this.clobClient) {
      await this.initClobClient();
    }
    if (!this.clobClient) {
      return {
        success: false,
        status: 'failed',
        message: 'CLOB client not available. Check private key and API credentials.',
      };
    }

    try {
      const client = this.clobClient as {
        createOrder(params: Record<string, unknown>): Promise<unknown>;
        postOrder(order: unknown): Promise<Record<string, unknown>>;
      };

      logger.info(`Placing ${side} order: ${size} @ $${price.toFixed(4)} (token: ${tokenId})`);

      // Create the signed order
      const order = await client.createOrder({
        tokenID: tokenId,
        price: price,
        size: size,
        side: side,
      });

      // Submit to the order book
      const response = await client.postOrder(order);

      const success = response.success === true || response.status === 'matched';
      const orderId = (response.orderID ?? response.id ?? '') as string;

      if (success) {
        logger.info(`Order placed successfully: ${orderId}`);

        // Poll for fill status (up to 30 seconds)
        const filled = await this.waitForFill(orderId, 30_000);
        return filled;
      }

      return {
        success: false,
        orderId,
        status: 'failed',
        message: `Order rejected: ${JSON.stringify(response)}`,
      };
    } catch (err) {
      logger.error('Trade execution failed', { error: (err as Error).message, tokenId, price, size });
      return {
        success: false,
        status: 'failed',
        message: (err as Error).message,
      };
    }
  }

  /**
   * Poll for order fill status.
   */
  private async waitForFill(orderId: string, timeoutMs: number): Promise<OrderResult> {
    const start = Date.now();
    const pollInterval = 2000;

    while (Date.now() - start < timeoutMs) {
      try {
        const client = this.clobClient as {
          getOrder(id: string): Promise<Record<string, unknown>>;
        };
        const order = await client.getOrder(orderId);
        const status = order.status as string;

        if (status === 'matched' || status === 'filled') {
          return {
            success: true,
            orderId,
            filledSize: order.size_matched as number,
            filledPrice: order.price as number,
            status: 'filled',
          };
        }

        if (status === 'cancelled' || status === 'expired') {
          return {
            success: false,
            orderId,
            status: 'failed',
            message: `Order ${status}`,
          };
        }

        // Check for partial fill
        const matched = (order.size_matched as number) ?? 0;
        if (matched > 0) {
          return {
            success: true,
            orderId,
            filledSize: matched,
            filledPrice: order.price as number,
            status: 'partial',
            message: `Partially filled: ${matched}`,
          };
        }
      } catch {
        // Ignore polling errors
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    // Timeout — treat as pending
    return {
      success: true,
      orderId,
      status: 'pending',
      message: 'Order still pending after timeout',
    };
  }

  // ============================================================
  // Positions
  // ============================================================

  /**
   * Get current open positions.
   */
  async getPositions(): Promise<Position[]> {
    if (CONFIG.trading.dryRun || !this.clobClient) {
      logger.debug('Positions not available in dry-run mode');
      return [];
    }

    try {
      const client = this.clobClient as {
        getPositions(): Promise<Record<string, unknown>[]>;
      };
      const rawPositions = await client.getPositions();
      return rawPositions.map((p) => ({
        marketId: p.market as string,
        tokenId: p.asset as string,
        outcome: p.outcome as string,
        size: p.size as number,
        avgPrice: p.avgPrice as number,
        currentPrice: p.curPrice as number,
        unrealizedPnl: ((p.curPrice as number) - (p.avgPrice as number)) * (p.size as number),
      }));
    } catch (err) {
      logger.error('Failed to fetch positions', { error: (err as Error).message });
      return [];
    }
  }

  // ============================================================
  // Parsing helpers
  // ============================================================

  private parseGammaMarket(raw: Record<string, unknown>): PolymarketMarket {
    const outcomes = (raw.outcomes as string[]) ?? [];
    const outcomePricesRaw = raw.outcomePrices as string | string[] | undefined;
    let outcomePrices: number[] = [];

    if (typeof outcomePricesRaw === 'string') {
      try {
        outcomePrices = JSON.parse(outcomePricesRaw);
      } catch {
        outcomePrices = outcomePricesRaw.split(',').map(Number);
      }
    } else if (Array.isArray(outcomePricesRaw)) {
      outcomePrices = outcomePricesRaw.map(Number);
    }

    // Build tokens
    const clobTokenIds = raw.clobTokenIds as string | string[] | undefined;
    let tokenIds: string[] = [];
    if (typeof clobTokenIds === 'string') {
      try {
        tokenIds = JSON.parse(clobTokenIds);
      } catch {
        tokenIds = clobTokenIds.split(',');
      }
    } else if (Array.isArray(clobTokenIds)) {
      tokenIds = clobTokenIds;
    }

    const tokens: MarketToken[] = outcomes.map((outcome, i) => ({
      tokenId: tokenIds[i] ?? '',
      outcome,
      price: outcomePrices[i] ?? 0,
    }));

    return {
      id: (raw.id ?? raw.conditionId ?? '') as string,
      conditionId: (raw.conditionId ?? '') as string,
      questionId: (raw.questionID ?? '') as string,
      question: (raw.question ?? '') as string,
      description: (raw.description ?? '') as string,
      slug: (raw.slug ?? '') as string,
      active: raw.active !== false,
      closed: raw.closed === true,
      endDate: (raw.endDate ?? raw.end_date_iso ?? '') as string,
      outcomes,
      outcomePrices,
      tokens,
      volume: Number(raw.volume ?? raw.volumeNum ?? 0),
      liquidity: Number(raw.liquidity ?? raw.liquidityNum ?? 0),
    };
  }

  /**
   * Parse temperature range from a market question string.
   * Handles patterns like:
   *   "Will NYC high temperature be 40-45°F on Feb 20?"
   *   "NYC: High temp between 40 and 45 degrees?"
   *   "40°F to 45°F" / "40-45 F" / "40 - 45°F"
   *   "above 50°F" / "below 30°F" / "over 60°F" / "under 25°F"
   */
  parseTemperatureRange(question: string): TemperatureRange | null {
    // Pattern: "X-Y°F" or "X to Y°F" or "between X and Y"
    const rangePatterns = [
      /(\d+)\s*[-–]\s*(\d+)\s*°?\s*[Ff]/,
      /(\d+)\s*°?\s*[Ff]?\s*to\s*(\d+)\s*°?\s*[Ff]/i,
      /between\s+(\d+)\s*°?\s*[Ff]?\s*and\s+(\d+)\s*°?\s*[Ff]/i,
    ];

    for (const pattern of rangePatterns) {
      const match = question.match(pattern);
      if (match) {
        return {
          low: parseInt(match[1]),
          high: parseInt(match[2]),
          unit: 'F',
          rawText: match[0],
        };
      }
    }

    // Pattern: "above/over X°F"
    const aboveMatch = question.match(/(?:above|over|more than|greater than|≥|>=)\s*(\d+)\s*°?\s*[Ff]/i);
    if (aboveMatch) {
      return {
        low: parseInt(aboveMatch[1]),
        high: 200, // effectively no upper bound
        unit: 'F',
        rawText: aboveMatch[0],
      };
    }

    // Pattern: "below/under X°F"
    const belowMatch = question.match(/(?:below|under|less than|lower than|≤|<=)\s*(\d+)\s*°?\s*[Ff]/i);
    if (belowMatch) {
      return {
        low: -100, // effectively no lower bound
        high: parseInt(belowMatch[1]),
        unit: 'F',
        rawText: belowMatch[0],
      };
    }

    return null;
  }

  /**
   * Clear the market cache.
   */
  clearCache(): void {
    this.marketCache.clear();
  }
}
