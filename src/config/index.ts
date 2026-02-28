import dotenv from 'dotenv';
import path from 'path';
import { CityConfig, RiskLimits } from '../types';

dotenv.config();

function envStr(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  return v !== undefined ? Number(v) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

// --------------- City Grid Point Configurations ---------------

export const CITIES: Record<string, CityConfig> = {
  NYC: {
    name: 'New York City',
    state: 'NY',
    lat: 40.7128,
    lon: -74.006,
    wfo: 'OKX',
    gridX: 33,
    gridY: 37,
    stationId: 'KNYC',
    searchKeywords: ['NYC temperature', 'New York City temperature', 'New York high temperature'],
  },
  LAX: {
    name: 'Los Angeles',
    state: 'CA',
    lat: 34.0522,
    lon: -118.2437,
    wfo: 'LOX',
    gridX: 154,
    gridY: 44,
    stationId: 'KLAX',
    searchKeywords: ['Los Angeles temperature', 'LA temperature', 'LA high temperature'],
  },
  CHI: {
    name: 'Chicago',
    state: 'IL',
    lat: 41.8781,
    lon: -87.6298,
    wfo: 'LOT',
    gridX: 76,
    gridY: 73,
    stationId: 'KORD',
    searchKeywords: ['Chicago temperature', 'Chicago high temperature'],
  },
  MIA: {
    name: 'Miami',
    state: 'FL',
    lat: 25.7617,
    lon: -80.1918,
    wfo: 'MFL',
    gridX: 110,
    gridY: 50,
    stationId: 'KMIA',
    searchKeywords: ['Miami temperature', 'Miami high temperature'],
  },
  DEN: {
    name: 'Denver',
    state: 'CO',
    lat: 39.7392,
    lon: -104.9903,
    wfo: 'BOU',
    gridX: 62,
    gridY: 60,
    stationId: 'KDEN',
    searchKeywords: ['Denver temperature', 'Denver high temperature'],
  },
};

// --------------- Main Config ---------------

export const CONFIG = {
  // NOAA
  noaa: {
    baseUrl: 'https://api.weather.gov',
    userAgent: envStr('NOAA_USER_AGENT', 'polymarket-weather-bot/1.0'),
    requestDelayMs: 1500,
    retryAttempts: 3,
    retryDelayMs: 2000,
  },

  // Polymarket
  polymarket: {
    gammaBaseUrl: 'https://gamma-api.polymarket.com',
    clobBaseUrl: 'https://clob.polymarket.com',
    chainId: 137,
    apiKey: envStr('POLYMARKET_API_KEY'),
    apiSecret: envStr('POLYMARKET_API_SECRET'),
    apiPassphrase: envStr('POLYMARKET_API_PASSPHRASE'),
    privateKey: envStr('POLYMARKET_PRIVATE_KEY'),
    /** Cache market data for this many minutes */
    marketCacheTtlMinutes: 10,
  },

  // Trading
  trading: {
    dryRun: envBool('DRY_RUN', true),
    bankroll: envNum('BANKROLL', 500),
    maxBetSize: envNum('MAX_BET_SIZE', 20),
    minEdge: envNum('MIN_EDGE', 0.15),
    /** Skip markets priced above this (less edge opportunity) */
    maxMarketPrice: 0.60,
    /** Kelly multiplier (0.25 = quarter Kelly) */
    kellyMultiplier: 0.25,
    /** Minimum expected value to consider a trade */
    minExpectedValue: 0.10,
    cronSchedule: envStr('CRON_SCHEDULE', '*/30 * * * *'),
  },

  // Risk limits
  risk: {
    maxTotalExposure: envNum('BANKROLL', 500) * 0.5,
    maxDailyLoss: envNum('BANKROLL', 500) * 0.1,
    maxDailyTrades: 20,
    maxConsecutiveLosses: 5,
    maxSingleBet: envNum('MAX_BET_SIZE', 20),
    cooldownMinutes: 60,
  } as RiskLimits,

  // Forecast error standard deviations (°F)
  forecastSigma: {
    hours24: 3.0,
    hours48: 4.5,
    hours72: 6.0,
    hours96: 7.5,
    hoursDefault: 8.0,
  },

  // Telegram
  telegram: {
    botToken: envStr('TELEGRAM_BOT_TOKEN'),
    chatId: envStr('TELEGRAM_CHAT_ID'),
  },

  // Paths
  paths: {
    dataDir: path.resolve(process.cwd(), 'data'),
    logsDir: path.resolve(process.cwd(), 'logs'),
    stateFile: path.resolve(process.cwd(), 'data', 'risk-state.json'),
    tradeLog: path.resolve(process.cwd(), 'data', 'trades.json'),
  },

  // Logging
  logLevel: envStr('LOG_LEVEL', 'info'),
};
