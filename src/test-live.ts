/**
 * Live integration test — verifies each API endpoint independently.
 * Run: npx tsc && node dist/test-live.js
 */

import axios from 'axios';
import { CONFIG, CITIES } from './config';
import { PolymarketClient } from './data/polymarket-client';
import { NOAAFetcher } from './data/noaa-fetcher';
import { StrategyEngine } from './strategy/engine';
import { logger } from './utils/logger';

async function testNOAA(): Promise<boolean> {
  console.log('\n=== 1. NOAA Weather API ===');
  try {
    const fetcher = new NOAAFetcher();
    const forecast = await fetcher.getForecast('NYC');
    const period = fetcher.findRelevantPeriod(forecast);
    if (period) {
      console.log(`  OK: ${period.name} = ${period.temperature}°${period.temperatureUnit}`);
      console.log(`  Forecast: "${period.shortForecast}"`);
      console.log(`  Hours ahead: ${period.hoursAhead}`);
    } else {
      console.log(`  OK: Got ${forecast.periods.length} periods but no relevant daytime found`);
      if (forecast.periods.length > 0) {
        const p = forecast.periods[0];
        console.log(`  First period: ${p.name} = ${p.temperature}°${p.temperatureUnit}`);
      }
    }
    return true;
  } catch (err) {
    console.log(`  FAIL: ${(err as Error).message}`);
    return false;
  }
}

async function testGammaAPI(): Promise<boolean> {
  console.log('\n=== 2. Polymarket Gamma API (Market Discovery) ===');
  try {
    const resp = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { _q: 'temperature', active: true, limit: 5 },
      timeout: 15_000,
    });
    const markets = Array.isArray(resp.data) ? resp.data : resp.data?.data ?? [];
    console.log(`  OK: Found ${markets.length} markets matching "temperature"`);
    for (const m of markets.slice(0, 3)) {
      console.log(`  - "${m.question}" (volume: ${m.volume ?? 'N/A'})`);
    }

    // Also search "weather"
    const resp2 = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { _q: 'weather', active: true, limit: 5 },
      timeout: 15_000,
    });
    const markets2 = Array.isArray(resp2.data) ? resp2.data : resp2.data?.data ?? [];
    console.log(`  Found ${markets2.length} markets matching "weather"`);
    for (const m of markets2.slice(0, 3)) {
      console.log(`  - "${m.question}"`);
    }
    return true;
  } catch (err) {
    console.log(`  FAIL: ${(err as Error).message}`);
    return false;
  }
}

async function testCLOBClient(): Promise<boolean> {
  console.log('\n=== 3. Polymarket CLOB Client ===');
  try {
    const client = new PolymarketClient();
    await client.initClobClient();
    console.log('  OK: CLOB client initialized');
    return true;
  } catch (err) {
    console.log(`  FAIL: ${(err as Error).message}`);
    return false;
  }
}

async function testCLOBOrderBook(): Promise<boolean> {
  console.log('\n=== 4. CLOB Order Book ===');
  try {
    // First find a market with a valid token ID
    const resp = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { _q: 'temperature', active: true, limit: 1, closed: false },
      timeout: 15_000,
    });
    const markets = Array.isArray(resp.data) ? resp.data : resp.data?.data ?? [];
    if (markets.length === 0) {
      console.log('  SKIP: No active temperature markets found');
      return true;
    }

    const market = markets[0];
    let tokenIds: string[] = [];
    if (typeof market.clobTokenIds === 'string') {
      try { tokenIds = JSON.parse(market.clobTokenIds); } catch { tokenIds = []; }
    }

    if (tokenIds.length === 0) {
      console.log('  SKIP: No CLOB token IDs available');
      return true;
    }

    const tokenId = tokenIds[0];
    console.log(`  Testing order book for token: ${tokenId.slice(0, 20)}...`);

    const client = new PolymarketClient();
    const book = await client.getOrderBook(tokenId);
    console.log(`  OK: bids=${book.bids.length}, asks=${book.asks.length}`);
    console.log(`  Best bid: ${book.bestBid}, Best ask: ${book.bestAsk}`);
    console.log(`  Spread: ${(book.spread * 100).toFixed(2)}%, Mid: ${book.midPrice.toFixed(4)}`);
    return true;
  } catch (err) {
    console.log(`  FAIL: ${(err as Error).message}`);
    return false;
  }
}

async function testFullPipeline(): Promise<void> {
  console.log('\n=== 5. Full Pipeline Test (Gamma → Signal) ===');
  try {
    const polymarket = new PolymarketClient();
    const markets = await polymarket.findWeatherMarkets('NYC');
    console.log(`  Found ${markets.length} weather markets for NYC`);

    for (const m of markets.slice(0, 3)) {
      console.log(`  - "${m.question}"`);
      if (m.temperatureRange) {
        console.log(`    Range: ${m.temperatureRange.low}–${m.temperatureRange.high}°F`);
      }
      for (const t of m.tokens) {
        console.log(`    ${t.outcome}: price=${t.price.toFixed(4)} (token: ${t.tokenId.slice(0, 16)}...)`);
      }
    }

    if (markets.length === 0) {
      console.log('  No weather markets — trying broader search...');
      const resp = await axios.get('https://gamma-api.polymarket.com/markets', {
        params: { _q: 'NYC', active: true, limit: 10 },
        timeout: 15_000,
      });
      const all = Array.isArray(resp.data) ? resp.data : resp.data?.data ?? [];
      console.log(`  Broader search found ${all.length} NYC-related markets`);
      for (const m of all.slice(0, 5)) {
        console.log(`  - "${m.question}"`);
      }
    }
  } catch (err) {
    console.log(`  FAIL: ${(err as Error).message}`);
  }
}

async function main() {
  console.log('============================================');
  console.log('   POLYMARKET WEATHER ARB — LIVE API TEST');
  console.log('============================================');
  console.log(`  Wallet: ${CONFIG.polymarket.privateKey ? 'configured' : 'NOT SET'}`);
  console.log(`  Mode: ${CONFIG.trading.dryRun ? 'DRY RUN' : 'LIVE'}`);

  const noaaOk = await testNOAA();
  const gammaOk = await testGammaAPI();
  const clobOk = await testCLOBClient();
  const bookOk = await testCLOBOrderBook();
  await testFullPipeline();

  console.log('\n============================================');
  console.log('   RESULTS');
  console.log('============================================');
  console.log(`  NOAA:        ${noaaOk ? 'PASS' : 'FAIL (network restricted)'}`);
  console.log(`  Gamma API:   ${gammaOk ? 'PASS' : 'FAIL'}`);
  console.log(`  CLOB Client: ${clobOk ? 'PASS' : 'FAIL'}`);
  console.log(`  Order Book:  ${bookOk ? 'PASS' : 'FAIL'}`);
  console.log('============================================\n');
}

main().catch(console.error);
