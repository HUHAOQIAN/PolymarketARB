// ============================================================
// Shared type definitions for Polymarket Weather Arbitrage Bot
// ============================================================

// --- Weather ---

export interface CityConfig {
  name: string;
  state: string;
  lat: number;
  lon: number;
  /** NOAA Weather Forecast Office ID */
  wfo: string;
  gridX: number;
  gridY: number;
  /** Nearby observation station ID */
  stationId: string;
  /** Polymarket search keywords for this city */
  searchKeywords: string[];
}

export interface WeatherForecast {
  city: string;
  fetchedAt: Date;
  /** Forecast periods (typically 14 half-day periods for 7 days) */
  periods: ForecastPeriod[];
}

export interface ForecastPeriod {
  name: string;
  startTime: string;
  endTime: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: 'F' | 'C';
  windSpeed: string;
  windDirection: string;
  shortForecast: string;
  detailedForecast: string;
  /** Hours from now until the start of this period */
  hoursAhead: number;
}

export interface WeatherObservation {
  city: string;
  stationId: string;
  timestamp: string;
  temperature: number;
  temperatureUnit: 'F' | 'C';
}

// --- Polymarket ---

export interface PolymarketMarket {
  id: string;
  conditionId: string;
  questionId: string;
  question: string;
  description: string;
  slug: string;
  active: boolean;
  closed: boolean;
  endDate: string;
  outcomes: string[];
  outcomePrices: number[];
  tokens: MarketToken[];
  volume: number;
  liquidity: number;
  /** Parsed temperature range from question text */
  temperatureRange?: TemperatureRange;
  /** Which city this market is for */
  city?: string;
}

export interface MarketToken {
  tokenId: string;
  outcome: string;
  price: number;
  winner?: boolean;
}

export interface TemperatureRange {
  low: number;
  high: number;
  unit: 'F' | 'C';
  /** Original text from market question */
  rawText: string;
}

export interface OrderBookEntry {
  price: number;
  size: number;
}

export interface OrderBook {
  tokenId: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  spread: number;
  midPrice: number;
  bestBid: number;
  bestAsk: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  filledSize?: number;
  filledPrice?: number;
  status: 'filled' | 'partial' | 'pending' | 'failed' | 'dry_run';
  message?: string;
}

export interface Position {
  marketId: string;
  tokenId: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
}

// --- Strategy ---

export interface TradingSignal {
  city: string;
  market: PolymarketMarket;
  /** The outcome/token we want to buy */
  targetOutcome: MarketToken;
  /** Our estimated true probability */
  estimatedProbability: number;
  /** Current market price (probability) */
  marketPrice: number;
  /** edge = estimatedProbability - marketPrice */
  edge: number;
  /** Kelly fraction (already adjusted to 1/4 Kelly) */
  kellyFraction: number;
  /** Suggested bet size in USDC */
  suggestedBetSize: number;
  /** Expected value of the bet */
  expectedValue: number;
  /** The forecast that generated this signal */
  forecast: ForecastPeriod;
  /** Confidence in the forecast (0-1) */
  confidence: number;
  /** Hours until market resolution */
  hoursToResolution: number;
  timestamp: Date;
}

export interface ProbabilityEstimate {
  /** Probability for each temperature range */
  rangeProbabilities: RangeProbability[];
  /** The NOAA forecast used */
  forecastTemp: number;
  /** Adjusted standard deviation */
  sigma: number;
  confidence: number;
}

export interface RangeProbability {
  low: number;
  high: number;
  probability: number;
}

// --- Risk Management ---

export interface TradeRecord {
  id: string;
  timestamp: Date;
  city: string;
  marketId: string;
  tokenId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  cost: number;
  estimatedProbability: number;
  edge: number;
  status: 'pending' | 'filled' | 'settled_win' | 'settled_loss' | 'cancelled';
  pnl?: number;
  settledAt?: Date;
}

export interface RiskState {
  totalExposure: number;
  dailyPnl: number;
  dailyTradeCount: number;
  consecutiveLosses: number;
  isPaused: boolean;
  pauseReason?: string;
  pauseUntil?: Date;
  lastTradeTime?: Date;
  trades: TradeRecord[];
}

export interface RiskLimits {
  maxTotalExposure: number;
  maxDailyLoss: number;
  maxDailyTrades: number;
  maxConsecutiveLosses: number;
  maxSingleBet: number;
  cooldownMinutes: number;
}

// --- Backtest ---

export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  initialBankroll: number;
  cities: string[];
}

export interface BacktestResult {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  sharpeRatio: number;
  avgEdge: number;
  avgBetSize: number;
  bankrollHistory: { date: Date; value: number }[];
  trades: TradeRecord[];
}

// --- Notification ---

export interface NotificationPayload {
  type: 'signal' | 'trade' | 'settlement' | 'error' | 'daily_report' | 'risk_alert';
  title: string;
  message: string;
  data?: Record<string, unknown>;
}
