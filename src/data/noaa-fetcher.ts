import axios, { AxiosInstance } from 'axios';
import { CONFIG, CITIES } from '../config';
import { CityConfig, WeatherForecast, ForecastPeriod, WeatherObservation } from '../types';
import { logger } from '../utils/logger';

export class NOAAFetcher {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: CONFIG.noaa.baseUrl,
      timeout: 15_000,
      headers: {
        'User-Agent': `(${CONFIG.noaa.userAgent})`,
        Accept: 'application/geo+json',
      },
    });
  }

  /**
   * Fetch 7-day forecast for a city.
   */
  async getForecast(cityKey: string): Promise<WeatherForecast> {
    const city = CITIES[cityKey];
    if (!city) throw new Error(`Unknown city: ${cityKey}`);

    const url = `/gridpoints/${city.wfo}/${city.gridX},${city.gridY}/forecast`;
    logger.info(`Fetching NOAA forecast for ${city.name}`, { url });

    const data = await this.requestWithRetry(url);
    const periods: ForecastPeriod[] = (data.properties?.periods ?? []).map(
      (p: Record<string, unknown>) => this.parsePeriod(p),
    );

    logger.info(`Got ${periods.length} forecast periods for ${city.name}`);
    return { city: cityKey, fetchedAt: new Date(), periods };
  }

  /**
   * Fetch hourly forecast for more precise temperature predictions.
   */
  async getHourlyForecast(cityKey: string): Promise<WeatherForecast> {
    const city = CITIES[cityKey];
    if (!city) throw new Error(`Unknown city: ${cityKey}`);

    const url = `/gridpoints/${city.wfo}/${city.gridX},${city.gridY}/forecast/hourly`;
    logger.info(`Fetching NOAA hourly forecast for ${city.name}`);

    const data = await this.requestWithRetry(url);
    const periods: ForecastPeriod[] = (data.properties?.periods ?? []).map(
      (p: Record<string, unknown>) => this.parsePeriod(p),
    );

    return { city: cityKey, fetchedAt: new Date(), periods };
  }

  /**
   * Fetch the latest observation from the nearest station (actual temperature).
   */
  async getLatestObservation(cityKey: string): Promise<WeatherObservation | null> {
    const city = CITIES[cityKey];
    if (!city) throw new Error(`Unknown city: ${cityKey}`);

    const url = `/stations/${city.stationId}/observations/latest`;
    logger.info(`Fetching latest observation for ${city.name}`);

    try {
      const data = await this.requestWithRetry(url);
      const props = data.properties;
      if (!props?.temperature?.value) return null;

      let temp = props.temperature.value as number;
      let unit: 'F' | 'C' = 'C';
      if (props.temperature.unitCode === 'wmoUnit:degC') {
        temp = temp * 9 / 5 + 32; // Convert to Fahrenheit
        unit = 'F';
      }

      return {
        city: cityKey,
        stationId: city.stationId,
        timestamp: props.timestamp as string,
        temperature: Math.round(temp),
        temperatureUnit: unit,
      };
    } catch (err) {
      logger.warn(`Failed to get observation for ${city.name}`, { error: (err as Error).message });
      return null;
    }
  }

  /**
   * Fetch forecasts for all configured cities.
   */
  async getAllForecasts(): Promise<WeatherForecast[]> {
    const forecasts: WeatherForecast[] = [];
    for (const cityKey of Object.keys(CITIES)) {
      try {
        const forecast = await this.getForecast(cityKey);
        forecasts.push(forecast);
        // Respect rate limits
        await this.delay(CONFIG.noaa.requestDelayMs);
      } catch (err) {
        logger.error(`Failed to fetch forecast for ${cityKey}`, { error: (err as Error).message });
      }
    }
    return forecasts;
  }

  /**
   * Get the sigma (standard deviation) for the forecast based on hours ahead.
   */
  getSigmaForHoursAhead(hoursAhead: number): number {
    if (hoursAhead <= 24) return CONFIG.forecastSigma.hours24;
    if (hoursAhead <= 48) return CONFIG.forecastSigma.hours48;
    if (hoursAhead <= 72) return CONFIG.forecastSigma.hours72;
    if (hoursAhead <= 96) return CONFIG.forecastSigma.hours96;
    return CONFIG.forecastSigma.hoursDefault;
  }

  /**
   * Extract the "tomorrow daytime high" period from a forecast.
   */
  getTomorrowDaytimePeriod(forecast: WeatherForecast): ForecastPeriod | null {
    // Find the first daytime period that starts more than 6 hours from now
    // but within 36 hours (i.e., "tomorrow daytime")
    const now = Date.now();
    for (const period of forecast.periods) {
      const start = new Date(period.startTime).getTime();
      const hoursFromNow = (start - now) / (1000 * 60 * 60);
      if (period.isDaytime && hoursFromNow >= 6 && hoursFromNow <= 36) {
        return { ...period, hoursAhead: Math.round(hoursFromNow) };
      }
    }
    return null;
  }

  /**
   * Find the nearest daytime forecast period within a window.
   */
  findRelevantPeriod(forecast: WeatherForecast, maxHoursAhead: number = 48): ForecastPeriod | null {
    const now = Date.now();
    for (const period of forecast.periods) {
      const start = new Date(period.startTime).getTime();
      const hoursFromNow = (start - now) / (1000 * 60 * 60);
      if (period.isDaytime && hoursFromNow > 0 && hoursFromNow <= maxHoursAhead) {
        return { ...period, hoursAhead: Math.round(hoursFromNow) };
      }
    }
    return null;
  }

  // --- Private helpers ---

  private parsePeriod(raw: Record<string, unknown>): ForecastPeriod {
    const startTime = raw.startTime as string;
    const hoursAhead = Math.round(
      (new Date(startTime).getTime() - Date.now()) / (1000 * 60 * 60),
    );

    return {
      name: raw.name as string,
      startTime,
      endTime: raw.endTime as string,
      isDaytime: raw.isDaytime as boolean,
      temperature: raw.temperature as number,
      temperatureUnit: (raw.temperatureUnit as string) === 'F' ? 'F' : 'C',
      windSpeed: raw.windSpeed as string,
      windDirection: raw.windDirection as string,
      shortForecast: raw.shortForecast as string,
      detailedForecast: raw.detailedForecast as string,
      hoursAhead,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async requestWithRetry(url: string, attempt = 1): Promise<any> {
    try {
      const response = await this.client.get(url);
      return response.data;
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number }; message?: string };
      if (attempt < CONFIG.noaa.retryAttempts && axiosErr.response?.status !== 404) {
        const backoff = CONFIG.noaa.retryDelayMs * Math.pow(2, attempt - 1);
        logger.warn(`NOAA request failed (attempt ${attempt}), retrying in ${backoff}ms`, {
          url,
          status: axiosErr.response?.status,
        });
        await this.delay(backoff);
        return this.requestWithRetry(url, attempt + 1);
      }
      throw err;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
