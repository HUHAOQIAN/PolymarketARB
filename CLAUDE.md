# Polymarket 天气套利 Bot - Claude Code 开发指南

## 项目概述

这是一个基于 NOAA 天气预报数据，在 Polymarket 预测市场上进行自动化套利交易的 Bot。核心逻辑是利用 NOAA 的高精度气象预报（24小时准确率 85-90%）与 Polymarket 上散户定价之间的偏差来获利。

**当前状态：Phase 1 MVP 骨架已完成，需要 Claude Code 完善以下部分。**

---

## 项目结构

```
polymarket-weather-arb/
├── package.json              # 依赖配置
├── tsconfig.json             # TypeScript 配置
├── .env.example              # 环境变量模板（复制为 .env 使用）
├── .gitignore
├── src/
│   ├── index.ts              # 主入口 - Bot 控制器和调度器
│   ├── types.ts              # 所有共享类型定义
│   ├── backtest.ts           # 回测引擎（模拟数据验证策略）
│   ├── config/
│   │   └── index.ts          # 集中配置管理（城市、API、交易参数）
│   ├── data/
│   │   ├── noaa-fetcher.ts   # NOAA 天气数据获取器
│   │   └── polymarket-client.ts  # Polymarket API 客户端（市场发现+交易）
│   ├── strategy/
│   │   └── engine.ts         # 策略引擎（概率模型、凯利公式）
│   ├── execution/
│   │   └── risk-manager.ts   # 风控管理器（限额、暂停、状态持久化）
│   ├── notification/
│   │   └── telegram.ts       # Telegram 推送通知
│   └── utils/
│       └── logger.ts         # Winston 日志
├── config/                   # 运行时配置目录
├── data/                     # 状态持久化目录（自动创建）
├── logs/                     # 日志目录
└── tests/                    # 测试目录
```

---

## 技术栈

- **Runtime**: Node.js >= 18
- **Language**: TypeScript
- **Package Manager**: npm >= 9

## 安装与运行

```bash
# 安装依赖
npm install

# 运行回测（验证策略逻辑）
npm run backtest

# 启动 Bot（模拟模式）
npm run dry-run

# 实盘模式
npm run start
```

## 环境变量

复制 `.env.example` 为 `.env`，至少填入：
- `NOAA_USER_AGENT` — 你的邮箱
- `DRY_RUN=true` — 先用模拟模式
- 实盘需要 `POLYMARKET_PRIVATE_KEY` 等认证信息

**安全：永远不要把 `.env` 文件提交到 Git。**

---

## 需要完善的部分

### 优先级 1: 关键功能（必须完成才能实盘）

#### 1.1 Polymarket CLOB API 交易签名

**文件：** `src/data/polymarket-client.ts` → `executeTrade()` 方法

当前状态：占位代码，标记为 `LIVE_TRADING_NOT_YET_IMPLEMENTED`

需要实现：
- 使用 `@polymarket/clob-client` SDK 初始化客户端
- 实现 API 签名流程（用以太坊私钥签名请求）
- 创建限价买单（BUY side）
- 等待成交确认
- 处理部分成交、超时等情况

参考：
- Polymarket CLOB API 文档: https://docs.polymarket.com/#create-order
- @polymarket/clob-client npm 包: https://www.npmjs.com/package/@polymarket/clob-client

```typescript
// 实现思路：
import { ClobClient } from '@polymarket/clob-client';

const client = new ClobClient(
  CONFIG.polymarket.clobEndpoint,
  137, // Polygon chainId
  wallet, // ethers.Wallet
  undefined,
  {
    key: CONFIG.polymarket.apiKey,
    secret: CONFIG.polymarket.apiSecret,
    passphrase: CONFIG.polymarket.apiPassphrase,
  }
);

const order = await client.createOrder({
  tokenID: signal.targetOutcome.tokenId,
  price: targetPrice,
  size: quantity,
  side: 'BUY',
});

const response = await client.postOrder(order);
```

#### 1.2 Polymarket 市场发现改进

**文件：** `src/data/polymarket-client.ts` → `findWeatherMarkets()` 方法

需要完善：
- 实际测试 Gamma API 返回的 JSON 结构，调整解析逻辑
- 添加按标签搜索（tag: "weather", "temperature"）
- 处理分页
- 缓存市场数据
- 获取实时价格（用 CLOB API 的实时订单簿替代 Gamma 快照价格）

#### 1.3 持仓跟踪和结算

**文件：** `src/data/polymarket-client.ts` → `getPositions()` 方法
**文件：** `src/execution/risk-manager.ts` → `recordSettlement()` 方法

需要实现：
- 查询当前持仓（通过 CLOB API）
- 监控市场结算状态
- 自动记录盈亏结果
- 触发风控规则（连续亏损暂停等）

### 优先级 2: 增强功能（提升策略效果）

#### 2.1 多数据源对比

**新文件建议：** `src/data/weather-aggregator.ts`

加入 Weather.com API、OpenWeatherMap API、AccuWeather API，多源对比提高置信度。

#### 2.2 历史回测

**文件：** `src/backtest.ts`

接入 NOAA 历史预报数据和 Polymarket 历史定价，统计胜率、夏普比率、最大回撤。

#### 2.3 概率模型改进

**文件：** `src/strategy/engine.ts`

改进方向：历史误差拟合、城市/季节差异化标准差、极端天气厚尾分布。

#### 2.4 订单簿深度分析

**新文件建议：** `src/strategy/liquidity-analyzer.ts`

交易前检查订单簿深度、滑点估算、买卖价差，自动调整仓位。

### 优先级 3: 扩展功能（Phase 2+）

- 多平台支持（Predict.fun, Kalshi 跨平台套利）
- Agent 层接入（LLM Agent 用于复杂场景判断）
- OpenClaw 集成（通过 WhatsApp/Telegram 控制 Bot）

---

## 核心算法

### 概率估计模型

NOAA 点预测转换为区间概率。假设实际温度 T ~ N(μ, σ²)：
- μ = NOAA 预测值
- σ = 预报误差标准差（24h: ~3°F, 48h: ~4.5°F, 72h: ~6°F）
- 区间概率: P(low ≤ T < high) = Φ((high - μ) / σ) - Φ((low - μ) / σ)
- 置信度调整: σ_adjusted = σ_base × (1.5 - confidence)

### Kelly Criterion（凯利公式）

```
f* = (p × b - q) / b
  p = 真实概率估计, q = 1 - p, b = (1 / market_price) - 1
使用 1/4 Kelly: bet_size = bankroll × f* × 0.25
```

### 交易决策流程

```
1. 获取 NOAA 预测 → highTemp, confidence
2. 找到目标区间
3. 估算真实概率 P
4. 获取市场定价 market_price
5. 计算 edge = P - market_price
6. edge > MIN_EDGE_THRESHOLD ? → 继续
7. Kelly 计算下注金额
8. 风控检查（最大仓位、日限额）
9. 执行买入
```

---

## API 参考

### NOAA Weather API
- 基础 URL: `https://api.weather.gov`
- 不需要认证，建议设置 User-Agent
- `GET /gridpoints/{office}/{gridX},{gridY}/forecast` → 7天逐日预报
- `GET /gridpoints/{office}/{gridX},{gridY}/forecast/hourly` → 逐小时预报
- `GET /stations/{stationId}/observations/latest` → 最新观测数据

### Polymarket Gamma API（市场发现）
- 基础 URL: `https://gamma-api.polymarket.com`
- 不需要认证
- `GET /markets` → 搜索市场（`_q` 全文搜索）

### Polymarket CLOB API（交易）
- 基础 URL: `https://clob.polymarket.com`
- 需要 API Key + 私钥签名
- `GET /book?token_id={id}` → 订单簿
- `POST /order` → 创建订单
- `GET /positions` → 持仓查询

---

## 配置说明

### 添加新城市

```bash
# 用经纬度查询 NOAA grid point
curl "https://api.weather.gov/points/{lat},{lon}"
# 将返回的 gridId, gridX, gridY 加到 src/config/index.ts 的 CITIES 对象
```

### 交易参数调优
- `MAX_BET_SIZE`: 建议从 $5-10 开始
- `MIN_EXPECTED_VALUE`: 0.15 (15%) 保守值，可试 0.10
- `MIN_EDGE_THRESHOLD`: 市场价 > 0.60 时跳过
- `CRON_SCHEDULE`: 30 分钟足够

---

## 安全注意事项

1. 永远不要把 `.env` 文件提交到 Git
2. 使用专门的交易钱包，不用主钱包
3. 至少跑 2 周模拟交易确认策略有效
4. 实盘初始资金建议 $200-500 USDC
5. 配置好 Telegram 通知监控异常
