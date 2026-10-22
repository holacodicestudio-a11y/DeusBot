const STARTING_CASH = 10000;
const FEE_RATE = 0.001;
const STORAGE_KEY = 'automaton.paper.account.v1';

const markets = [
  { symbol: 'BTC', name: 'Bitcoin', pair: 'BTC / USDT', group: 'Cripto', icon: '₿', iconClass: 'btc', base: 67420, volatility: 0.0009, day: 1.84 },
  { symbol: 'ETH', name: 'Ethereum', pair: 'ETH / USDT', group: 'Cripto', icon: 'Ξ', iconClass: 'eth', base: 3528.4, volatility: 0.0012, day: -0.62 },
  { symbol: 'SOL', name: 'Solana', pair: 'SOL / USDT', group: 'Cripto', icon: '◎', iconClass: 'sol', base: 182.75, volatility: 0.0017, day: 3.21 },
];

function freshState() {
  const quotes = {};
  for (const asset of markets) quotes[asset.symbol] = { price: asset.base, dayOpen: asset.base / (1 + asset.day / 100), points: [0.44, 0.48, 0.45, 0.55, 0.51, 0.61, 0.57, 0.66], priceHistory: [asset.base] };
  return { cash: STARTING_CASH, initialCash: STARTING_CASH, positions: {}, history: [], quotes, botStrategy: 'confluence', botManaged: {}, datasets: {} };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const saved = JSON.parse(raw);
    if (!saved || !Number.isFinite(saved.cash) || !saved.quotes || !saved.positions || !Array.isArray(saved.history)) return freshState();
    const initial = freshState();
    for (const asset of markets) {
      const quote = saved.quotes[asset.symbol];
      if (quote && quote.source !== 'live' && Number.isFinite(quote.price) && quote.price > 0) initial.quotes[asset.symbol] = { ...initial.quotes[asset.symbol], ...quote, priceHistory: Array.isArray(quote.priceHistory) ? quote.priceHistory.filter(Number.isFinite).slice(-300) : [quote.price] };
    }
    const datasets = {};
    for (const asset of markets) {
      const dataset = saved.datasets?.[asset.symbol];
      if (dataset && Array.isArray(dataset.candles)) {
        const candles = dataset.candles.filter((bar) => bar && Number.isFinite(bar.time) && Number.isFinite(bar.close) && bar.close > 0).slice(-5000);
        if (candles.length) datasets[asset.symbol] = { ...dataset, candles };
      }
    }
    return { ...initial, cash: saved.cash, initialCash: Number.isFinite(saved.initialCash) ? saved.initialCash : STARTING_CASH, positions: Object.fromEntries(Object.entries(saved.positions).filter(([symbol]) => markets.some((asset) => asset.symbol === symbol))), history: saved.history.filter((trade) => markets.some((asset) => asset.symbol === trade.symbol)).slice(0, 500), botStrategy: ['trend', 'rsi', 'breakout', 'confluence'].includes(saved.botStrategy) ? saved.botStrategy : 'confluence', botManaged: saved.botManaged && typeof saved.botManaged === 'object' ? saved.botManaged : {}, datasets };
  } catch { return freshState(); }
}

let state = loadState();
let activeView = 'overview';
let tradeSide = 'buy';
let activeFilter = 'Todos';
let toastTimer;
let botActive = false;
let botSignals = {};
let botLastOrder = {};
let liveSocket = null;
let liveMode = false;
let streamConnected = false;
let streamSubscribed = false;
let liveConnecting = false;
let liveHeartbeat = null;
let liveLastUpdate = 0;
let lastLiveUiUpdate = 0;
let pendingLiveQuotes = {};
const providerSymbols = { BTC: 'btcusdt', ETH: 'ethusdt', SOL: 'solusdt' };
let futuresContext = {};
let futuresTimer = null;

const $ = (id) => document.getElementById(id);
const money = (value, digits = 2) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const qtyFormat = (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(value);
const signedMoney = (value) => `${value >= 0 ? '+' : '−'}${money(Math.abs(value))}`;
const assetFor = (symbol) => markets.find((asset) => asset.symbol === symbol);

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { showToast('No se pudo guardar en este navegador.'); }
}

function valueOfPortfolio() {
  return state.cash + Object.entries(state.positions).reduce((sum, [symbol, position]) => sum + position.quantity * state.quotes[symbol].price, 0);
}

function positionPnl(symbol, position) { return (state.quotes[symbol].price - position.averagePrice) * position.quantity; }

function renderMetrics() {
  const portfolio = valueOfPortfolio();
  const pnl = portfolio - state.initialCash;
  const openPositions = Object.values(state.positions).filter((position) => position.quantity > 1e-10);
  $('portfolio-value').textContent = money(portfolio);
  $('cash-value').textContent = money(state.cash);
  $('pnl-value').textContent = signedMoney(pnl);
  $('pnl-value').className = `metric-value ${pnl >= 0 ? 'positive' : 'negative'}`;
  $('pnl-percent').textContent = `${pnl >= 0 ? '+' : ''}${(pnl / state.initialCash * 100).toFixed(2)}%`;
  $('pnl-percent').className = pnl >= 0 ? 'positive' : 'negative';
  $('positions-count').textContent = String(openPositions.length);
  $('active-assets').textContent = `${openPositions.length} ${openPositions.length === 1 ? 'activo' : 'activos'}`;
}

function sparkline(symbol) {
  const points = state.quotes[symbol].points;
  const min = Math.min(...points), max = Math.max(...points), range = max - min || 1;
  const coords = points.map((point, index) => `${(index / (points.length - 1) * 72).toFixed(1)},${(22 - (point - min) / range * 19).toFixed(1)}`).join(' ');
  const dayChange = (state.quotes[symbol].price / state.quotes[symbol].dayOpen - 1) * 100;
  return `<svg class="mini-chart ${dayChange < 0 ? 'down' : ''}" viewBox="0 0 72 24" aria-hidden="true"><polyline points="${coords}"/></svg>`;
}

function loadTradingViewChart() {
  const field = $('tv-symbol');
  const container = $('tv-chart');
  const symbol = field.value.trim().toUpperCase();
  if (!/^[A-Z0-9._-]+:[A-Z0-9._-]+$/.test(symbol)) {
    showToast('Usa el formato EXCHANGE:SÍMBOLO, por ejemplo NASDAQ:AAPL.');
    field.focus();
    return;
  }
  container.replaceChildren();
  const frame = document.createElement('div');
  frame.className = 'tradingview-widget-container';
  frame.style.cssText = 'height:100%;width:100%';
  const widget = document.createElement('div');
  widget.className = 'tradingview-widget-container__widget';
  widget.style.cssText = 'height:calc(100% - 32px);width:100%';
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.async = true;
  script.textContent = JSON.stringify({ autosize: true, symbol, interval: '15', timezone: 'America/Mexico_City', theme: 'dark', style: '1', locale: 'es', allow_symbol_change: true, calendar: false, support_host: 'https://www.tradingview.com' });
  frame.append(widget);
  container.append(frame);
  frame.append(script);
}

async function refreshTradingViewSignals() {
  if (!['http:', 'https:'].includes(location.protocol)) return;
  const status = $('tv-alert-status');
  try {
    const [healthResponse, signalsResponse] = await Promise.all([
      fetch('/health', { cache: 'no-store' }),
      fetch('/api/tradingview/signals', { cache: 'no-store' }),
    ]);
    if (!healthResponse.ok || !signalsResponse.ok) throw new Error('service_unavailable');
    const health = await healthResponse.json();
    const payload = await signalsResponse.json();
    status.textContent = health.webhookConfigured ? 'Receptor activo · alertas en modo registro' : 'Servicio activo · configurar el secreto del webhook';
    const items = Array.isArray(payload.signals) ? payload.signals : [];
    $('tv-alert-list').innerHTML = items.length ? items.map((signal) => {
      const action = String(signal.action || '').toUpperCase();
      const time = signal.receivedAt ? new Date(signal.receivedAt).toLocaleString('es-MX') : '';
      return `<article class="tv-alert-row"><strong>${escapeHtml(signal.symbol || '')}</strong><span class="tv-alert-action ${['BUY', 'LONG'].includes(action) ? 'buy-signal' : ['SELL', 'SHORT'].includes(action) ? 'sell-signal' : ''}">${escapeHtml(action)}</span><span>${money(Number(signal.price) || 0)}</span><small>${escapeHtml(signal.interval || '')} · ${escapeHtml(time)}</small></article>`;
    }).join('') : '<div class="tv-alert-empty">Todavía no hay alertas recibidas.</div>';
  } catch {
    status.textContent = 'Servicio remoto sin conexión';
    $('tv-alert-list').innerHTML = '<div class="tv-alert-empty">El receptor todavía no está publicado o no responde.</div>';
  }
}

function changeMarkup(symbol) {
  const pct = (state.quotes[symbol].price / state.quotes[symbol].dayOpen - 1) * 100;
  return `<span class="change-badge ${pct >= 0 ? 'positive' : 'negative'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`;
}

function priceMarkup(symbol) {
  const price = state.quotes[symbol].price;
  return money(price, price < 10 ? 4 : 2);
}

function renderFeatured() {
  $('featured-markets').innerHTML = markets.slice(0, 3).map((asset) => `
    <article class="market-card">
      <div class="asset-top"><span class="asset-icon ${asset.iconClass}">${asset.icon}</span><span class="asset-name"><strong>${asset.name}</strong><small>${asset.pair}</small></span>${changeMarkup(asset.symbol)}</div>
      <div class="market-price">${priceMarkup(asset.symbol)}</div>
      <div class="card-bottom"><span>${liveMode ? 'Variación diaria' : 'Variación simulada'}</span>${sparkline(asset.symbol)}<button class="card-trade" data-trade="${asset.symbol}">Operar →</button></div>
    </article>`).join('');
}

function renderPositions() {
  const positions = Object.entries(state.positions).filter(([, position]) => position.quantity > 1e-10);
  if (!positions.length) {
    $('positions-content').innerHTML = '<div class="empty-state"><div><div class="empty-icon">◌</div><strong>Aún no tienes posiciones</strong>Abre una operación simulada para empezar.</div></div>';
    return;
  }
  $('positions-content').innerHTML = positions.map(([symbol, position]) => {
    const asset = assetFor(symbol), pnl = positionPnl(symbol, position);
    return `<div class="position-row"><span class="asset-icon ${asset.iconClass}">${asset.icon}</span><span class="row-main"><strong>${asset.name}</strong><small>${qtyFormat(position.quantity)} ${symbol} · promedio ${money(position.averagePrice, 2)}</small></span><span class="row-value">${money(position.quantity * state.quotes[symbol].price)}<small class="${pnl >= 0 ? 'positive' : 'negative'}">${signedMoney(pnl)}</small></span></div>`;
  }).join('');
}

function activityRow(trade) {
  const asset = assetFor(trade.symbol);
  if (!asset) return '';
  const date = new Date(trade.at);
  const localTime = Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
  return `<div class="activity-row"><span class="trade-type ${trade.side}">${trade.side === 'buy' ? '↗' : '↙'}</span><span class="row-main"><strong>${trade.side === 'buy' ? 'Compra' : 'Venta'} · ${asset.name}</strong><small>${qtyFormat(trade.quantity)} ${trade.symbol} · ${localTime}</small></span><span class="row-value">${money(trade.total)}<small>Comisión ${money(trade.fee)}</small></span></div>`;
}

function renderRecentActivity() {
  const rows = state.history.slice(0, 4);
  $('recent-activity').innerHTML = rows.length ? rows.map(activityRow).join('') : '<div class="empty-state"><div><div class="empty-icon">↗</div><strong>Tu actividad aparecerá aquí</strong>Aún no has hecho operaciones.</div></div>';
}

function renderMarkets() {
  const query = $('market-search').value.trim().toLowerCase();
  const filtered = markets.filter((asset) => (activeFilter === 'Todos' || asset.group === activeFilter) && `${asset.name} ${asset.symbol} ${asset.pair} ${asset.group}`.toLowerCase().includes(query));
  $('markets-table').innerHTML = filtered.length ? filtered.map((asset) => `
    <tr><td><span class="table-asset"><span class="asset-icon ${asset.iconClass}">${asset.icon}</span><span><strong>${asset.name}</strong><small>${asset.pair}</small></span></span></td><td>${priceMarkup(asset.symbol)}</td><td>${changeMarkup(asset.symbol)}</td><td><span class="class-tag">${asset.group}</span></td><td><button class="table-action" data-trade="${asset.symbol}">Operar</button></td></tr>`).join('') : '<tr><td class="no-results" colspan="5">No se encontraron activos con ese filtro.</td></tr>';
}

function renderHistory() {
  $('history-count').textContent = `${state.history.length} ${state.history.length === 1 ? 'operación' : 'operaciones'}`;
  if (!state.history.length) {
    $('history-content').innerHTML = '<div class="empty-state"><div><div class="empty-icon">≋</div><strong>Sin operaciones todavía</strong>Cuando hagas una operación simulada, la verás aquí.</div></div>';
    return;
  }
  $('history-content').innerHTML = `<div class="table-scroll"><table class="history-table"><thead><tr><th>TIPO</th><th>ACTIVO</th><th>CANTIDAD</th><th>PRECIO</th><th>COMISIÓN</th><th>FECHA</th></tr></thead><tbody>${state.history.map((trade) => {
    const asset = assetFor(trade.symbol), date = new Date(trade.at);
    const dateText = Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    return `<tr><td><span class="trade-type ${trade.side}">${trade.side === 'buy' ? '↗' : '↙'}</span> <span class="${trade.side === 'buy' ? 'positive' : 'negative'}">${trade.side === 'buy' ? 'Compra' : 'Venta'}</span></td><td>${asset?.name ?? trade.symbol} <span style="color:#71808c">${trade.symbol}</span></td><td>${qtyFormat(trade.quantity)}</td><td>${money(trade.price, trade.price < 10 ? 4 : 2)}</td><td>${money(trade.fee)}</td><td>${dateText}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderHistoricalData() {
  const select = $('history-asset');
  if (!select) return;
  if (!select.options.length) select.innerHTML = markets.map((asset) => `<option value="${asset.symbol}">${asset.name} · ${asset.symbol}</option>`).join('');
  const symbol = select.value || markets[0].symbol;
  const asset = assetFor(symbol), dataset = state.datasets[symbol];
  const cryptoAvailable = ['BTC', 'ETH', 'SOL'].includes(symbol);
  $('download-history').disabled = !cryptoAvailable;
  $('history-source-note').textContent = cryptoAvailable
    ? 'Descarga velas diarias públicas de Binance Spot. También puedes importar CSV con columnas Date, Open, High, Low, Close y Volume.'
    : 'Importa velas de criptomonedas en CSV con columnas Date, Open, High, Low, Close y Volume.';
  if (!dataset) {
    $('historical-status').innerHTML = `<div class="dataset-status"><span>${escapeHtml(asset.name)}</span><strong>Sin historial cargado</strong><span class="source-name">Fuente pendiente</span></div>`;
    return;
  }
  const first = new Date(dataset.candles[0].time), last = new Date(dataset.candles.at(-1).time);
  const dateRange = `${new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeZone: 'UTC' }).format(first)} – ${new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeZone: 'UTC' }).format(last)}`;
  $('historical-status').innerHTML = `<div class="dataset-status"><span><strong>${escapeHtml(asset.name)}</strong> · ${dataset.candles.length.toLocaleString('es-MX')} velas · ${escapeHtml(dateRange)}</span><span class="source-name">${escapeHtml(dataset.source || 'CSV importado')}</span></div>`;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 3) throw new Error('El archivo necesita un encabezado y varias filas de precios.');
  const delimiter = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const headers = lines[0].split(delimiter).map((value) => value.trim().replace(/^"|"$/g, '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  const pick = (...names) => headers.findIndex((header) => names.includes(header));
  const dateIndex = pick('date', 'datetime', 'timestamp', 'time', 'fecha');
  const closeIndex = pick('close', 'adj close', 'adj_close', 'cierre');
  if (dateIndex < 0 || closeIndex < 0) throw new Error('No encontré columnas de fecha y cierre. Usa Date y Close.');
  const indexes = { date: dateIndex, open: pick('open', 'apertura'), high: pick('high', 'maximo'), low: pick('low', 'minimo'), close: closeIndex, volume: pick('volume', 'volumen') };
  const numberAt = (parts, index, fallback = 0) => {
    if (index < 0) return fallback;
    const raw = (parts[index] || '').trim().replace(/^"|"$/g, '').replaceAll(',', '').replaceAll('$', '');
    const value = Number(raw); return Number.isFinite(value) ? value : fallback;
  };
  const candleMap = new Map();
  for (const line of lines.slice(1)) {
    const parts = line.split(delimiter);
    const rawDate = (parts[indexes.date] || '').trim().replace(/^"|"$/g, '');
    let time = Date.parse(rawDate);
    if (!Number.isFinite(time) && /^\d+(\.\d+)?$/.test(rawDate)) { const numeric = Number(rawDate); time = numeric > 1e12 ? numeric : numeric > 1e9 ? numeric * 1000 : (numeric - 25569) * 86400000; }
    const close = numberAt(parts, indexes.close, NaN);
    if (!Number.isFinite(time) || !(close > 0)) continue;
    const open = numberAt(parts, indexes.open, close);
    candleMap.set(time, { time, open: open > 0 ? open : close, high: numberAt(parts, indexes.high, Math.max(open, close)), low: numberAt(parts, indexes.low, Math.min(open, close)), close, volume: numberAt(parts, indexes.volume, 0) });
  }
  const candles = [...candleMap.values()].sort((a, b) => a.time - b.time).slice(-5000);
  if (candles.length < 50) throw new Error(`Solo pude leer ${candles.length} velas válidas; se requieren al menos 50.`);
  return candles;
}

async function downloadHistory() {
  const symbol = $('history-asset').value;
  const pair = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' }[symbol];
  if (!pair) return;
  const button = $('download-history'); button.disabled = true; button.textContent = 'Descargando…';
  try {
    const url = new URL('https://data-api.binance.vision/api/v3/klines');
    url.search = new URLSearchParams({ symbol: pair, interval: '1d', limit: '365' }).toString();
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) throw new Error(`La fuente respondió ${response.status}.`);
    const raw = await response.json();
    const now = Date.now();
    const candles = raw.map((row) => ({ time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), closeTime: Number(row[6]) })).filter((bar) => Number.isFinite(bar.time) && Number.isFinite(bar.close) && bar.close > 0 && bar.closeTime < now).map(({ closeTime, ...bar }) => bar);
    if (candles.length < 50) throw new Error('La fuente devolvió menos de 50 velas válidas.');
    state.datasets[symbol] = { source: `Binance Spot · ${pair}`, interval: '1d', fetchedAt: new Date().toISOString(), candles };
    save(); renderHistoricalData(); $('backtest-results').innerHTML = '<div class="empty-state compact-empty"><div><strong>Historial actualizado</strong>Ejecuta la comparación para ver resultados de entrenamiento y prueba.</div></div>';
    showToast(`${candles.length} velas diarias reales guardadas para ${symbol}.`);
  } catch (error) {
    showToast(`No pude descargar el historial. ${error.message} Puedes importar un CSV.`);
  } finally { button.textContent = 'Descargar 365 días'; button.disabled = !['BTC', 'ETH', 'SOL'].includes($('history-asset').value); }
}

function runBacktestSegment(candles, strategy, start, end) {
  let cash = STARTING_CASH, quantity = 0, entryPrice = 0, completed = 0, peak = STARTING_CASH, maxDrawdown = 0;
  const close = (index) => candles[index].close;
  const signalAt = (index) => {
    const current = close(index), history = candles.slice(0, index + 1).map((bar) => bar.close);
    if (strategy === 'trend') {
      if (history.length < 20) return 'wait';
      return mean(history.slice(-5)) > mean(history.slice(-20)) ? 'buy' : 'sell';
    }
    if (strategy === 'rsi') {
      const rsi = calculateRsi(history);
      return rsi === null ? 'wait' : rsi <= 30 ? 'buy' : rsi >= 55 ? 'sell' : 'hold';
    }
    if (history.length < 21) return 'wait';
    const previous = history.slice(-21, -1);
    return current > Math.max(...previous) ? 'buy' : current < Math.min(...previous) ? 'sell' : 'hold';
  };
  for (let index = Math.max(start, 20); index <= end; index++) {
    const barIndex = Math.min(index + 1, end);
    const bar = candles[barIndex];
    let execution = barIndex > index ? bar.open : bar.close;
    if (!(execution > 0)) execution = bar.close;
    if (quantity > 0 && bar.low <= entryPrice * 0.97) {
      const stopPrice = entryPrice * 0.97;
      const fill = bar.open < stopPrice ? bar.open : stopPrice;
      cash += quantity * fill * (1 - FEE_RATE); quantity = 0; entryPrice = 0; completed++;
    } else {
      const signal = signalAt(index);
      if (quantity === 0 && signal === 'buy') {
        const equity = cash;
        const notional = Math.min(equity * 0.15, cash / (1 + FEE_RATE));
        if (notional >= 10) { quantity = notional / execution; entryPrice = execution; cash -= notional * (1 + FEE_RATE); }
      } else if (quantity > 0 && signal === 'sell') {
        cash += quantity * execution * (1 - FEE_RATE); quantity = 0; entryPrice = 0; completed++;
      }
    }
    const equity = cash + quantity * bar.close;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  const finalEquity = cash + quantity * close(end);
  return { returnPct: (finalEquity / STARTING_CASH - 1) * 100, maxDrawdownPct: maxDrawdown * 100, completed, finalEquity };
}

function compareHistoricalStrategies() {
  const symbol = $('history-asset').value, dataset = state.datasets[symbol];
  if (!dataset) { showToast('Primero descarga o importa el historial de este activo.'); return; }
  const candles = dataset.candles;
  if (candles.length < 50) { showToast('Se necesitan al menos 50 velas válidas.'); return; }
  const split = Math.floor(candles.length * 0.7), strategies = [
    { key: 'trend', name: 'Tendencia SMA 5/20' },
    { key: 'rsi', name: 'Reversión RSI 14' },
    { key: 'breakout', name: 'Ruptura · 20 velas' }
  ];
  const results = strategies.map((strategy) => ({ ...strategy, train: runBacktestSegment(candles, strategy.key, 0, split - 1), test: runBacktestSegment(candles, strategy.key, split, candles.length - 1) }));
  const testStart = new Date(candles[split].time), testEnd = new Date(candles.at(-1).time);
  const dates = `${new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeZone: 'UTC' }).format(testStart)} – ${new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeZone: 'UTC' }).format(testEnd)}`;
  const rows = results.map((result) => `<tr><td>${result.name}</td><td class="${result.train.returnPct >= 0 ? 'positive' : 'negative'}">${result.train.returnPct >= 0 ? '+' : ''}${result.train.returnPct.toFixed(2)}%</td><td class="${result.test.returnPct >= 0 ? 'positive' : 'negative'}">${result.test.returnPct >= 0 ? '+' : ''}${result.test.returnPct.toFixed(2)}%</td><td>${result.test.maxDrawdownPct.toFixed(2)}%</td><td>${result.test.completed}</td></tr>`).join('');
  $('backtest-results').innerHTML = `<div class="backtest-heading"><strong>Comparación histórica · ${escapeHtml(assetFor(symbol).name)}</strong><span>Prueba fuera de muestra: ${escapeHtml(dates)}</span></div><div class="table-scroll backtest-results"><table><thead><tr><th>ESTRATEGIA</th><th>ENTRENAMIENTO · 70%</th><th>PRUEBA · 30%</th><th>CAÍDA MÁX. EN PRUEBA</th><th>OPERACIONES CERRADAS</th></tr></thead><tbody>${rows}</tbody></table></div><div class="backtest-caveat">Simulación larga únicamente, comisión ${ (FEE_RATE * 100).toFixed(2) }% por operación y stop −3%. Las órdenes se valoran con la apertura siguiente; no incluye spread, slippage, impuestos ni deslistes. El bloque de prueba no se usa para ajustar la regla. Esto es un filtro inicial, no una promesa de resultados.</div>`;
}

function importHistoricalCsv(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const candles = parseCsv(String(reader.result ?? ''));
      const symbol = $('history-asset').value;
      state.datasets[symbol] = { source: `CSV · ${file.name}`, interval: 'CSV', fetchedAt: new Date().toISOString(), candles };
      save(); renderHistoricalData(); $('backtest-results').innerHTML = '<div class="empty-state compact-empty"><div><strong>Historial importado</strong>Ejecuta la comparación para revisar entrenamiento y prueba.</div></div>';
      showToast(`${candles.length} velas históricas importadas para ${symbol}.`);
    } catch (error) { showToast(error.message); }
    $('history-file').value = '';
  };
  reader.onerror = () => showToast('No pude leer ese archivo CSV.');
  reader.readAsText(file);
}

const strategyCopy = {
  trend: 'Entra cuando la media rápida cruza por encima de la lenta y sale cuando cruza por debajo.',
  rsi: 'Busca rebotes tras lecturas de sobreventa (RSI ≤ 30) y sale cuando el RSI recupera 55.',
  breakout: 'Entra al superar el máximo de los 20 periodos previos y sale si cae bajo el mínimo del rango.',
  confluence: 'Combina tendencia y RSI de velas reales de 1 min con CVD y libro Spot; añade funding y long/short de futuros cuando están disponibles.'
};

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }

function calculateRsi(values, period = 14) {
  if (values.length < period + 1) return null;
  const changes = values.slice(-(period + 1)).slice(1).map((value, index) => value - values[values.length - period - 1 + index]);
  const gains = changes.reduce((sum, change) => sum + Math.max(change, 0), 0) / period;
  const losses = changes.reduce((sum, change) => sum + Math.max(-change, 0), 0) / period;
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
}

function getBotSignal(symbol) {
  const history = state.quotes[symbol].priceHistory;
  const quote = state.quotes[symbol];
  const held = Boolean(state.positions[symbol]?.quantity);
  if (state.botStrategy === 'confluence') {
    if (!liveMode || history.length < 21 || !Number.isFinite(quote.cvd) || !Number.isFinite(quote.bookImbalance)) return { action: 'wait', text: 'Esperando historial y fuentes Spot en vivo' };
    const fast = mean(history.slice(-5)), slow = mean(history.slice(-20)), rsi = calculateRsi(history), futures = futuresContext[symbol];
    const score = Number(fast > slow) + Number(rsi !== null && rsi > 35 && rsi < 68) + Number(quote.cvd > 0) + Number(quote.bookImbalance > 0.04) + Number(Boolean(futures && futures.funding < 0.001 && futures.ratio < 2.2));
    if (!held && score >= 4) return { action: 'buy', text: `Confluencia ${score}/5 · tendencia, RSI ${rsi.toFixed(0)}, flujo y contexto` };
    if (held && (score <= 1 || (rsi !== null && rsi > 75))) return { action: 'sell', text: `Salida de confluencia ${score}/5 · proteger la posición` };
    return { action: held ? 'hold' : 'wait', text: `Confluencia ${score}/5 · faltan confirmaciones` };
  }
  if (state.botStrategy === 'trend') {
    if (history.length < 20) return { action: 'wait', text: `Reuniendo datos · ${history.length}/20 periodos` };
    const fast = mean(history.slice(-5)), slow = mean(history.slice(-20));
    if (fast > slow) return { action: held ? 'hold' : 'buy', text: `Sesgo alcista · SMA 5 ${priceCompact(fast)} / SMA 20 ${priceCompact(slow)}` };
    return { action: held ? 'sell' : 'wait', text: `Sesgo bajista · SMA 5 ${priceCompact(fast)} / SMA 20 ${priceCompact(slow)}` };
  }
  if (state.botStrategy === 'rsi') {
    const rsi = calculateRsi(history);
    if (rsi === null) return { action: 'wait', text: `Reuniendo datos · ${history.length}/15 periodos` };
    if (rsi <= 30) return { action: held ? 'hold' : 'buy', text: `RSI ${rsi.toFixed(1)} · zona de sobreventa` };
    if (held && rsi >= 55) return { action: 'sell', text: `RSI ${rsi.toFixed(1)} · condición de salida` };
    return { action: held ? 'hold' : 'wait', text: `RSI ${rsi.toFixed(1)} · sin entrada` };
  }
  if (history.length < 21) return { action: 'wait', text: `Reuniendo datos · ${history.length}/21 periodos` };
  const prior = history.slice(-21, -1), high = Math.max(...prior), low = Math.min(...prior), price = history.at(-1);
  if (price > high) return { action: held ? 'hold' : 'buy', text: `Ruptura al alza · máximo ${priceCompact(high)}` };
  if (held && price < low) return { action: 'sell', text: `Ruptura a la baja · mínimo ${priceCompact(low)}` };
  return { action: held ? 'hold' : 'wait', text: `Dentro del rango · ${priceCompact(low)}–${priceCompact(high)}` };
}

function priceCompact(value) { return value < 10 ? money(value, 4) : money(value, 2); }

function renderAutomation() {
  const select = $('strategy-select');
  if (!select) return;
  select.value = state.botStrategy;
  select.disabled = botActive;
  $('strategy-description').textContent = strategyCopy[state.botStrategy];
  $('bot-status').classList.toggle('running', botActive);
  $('bot-status').innerHTML = `<i></i> ${botActive ? 'EN EJECUCIÓN' : 'DETENIDO'}`;
  $('bot-orb').classList.toggle('running', botActive);
  $('bot-main-label').textContent = botActive ? 'Automatización activa' : 'Listo para iniciar';
  $('bot-sub-label').textContent = botActive ? 'Analizando el mercado; solo ejecuta órdenes ficticias Spot.' : 'Conecta Binance Spot antes de activar el bot.';
  $('bot-toggle').textContent = botActive ? 'Pausar automatización' : 'Iniciar automatización';
  $('bot-toggle').classList.toggle('paused', botActive);
  const cards = markets.slice(0, 6).map((asset) => {
    const signal = botSignals[asset.symbol] ?? getBotSignal(asset.symbol);
    const labels = { buy: 'Señal de compra', sell: 'Señal de venta', hold: 'Mantener posición', wait: 'Sin señal de entrada' };
    return `<div class="signal-card"><div><span class="asset-icon ${asset.iconClass}">${asset.icon}</span><strong>${asset.symbol}</strong></div><div class="signal-state ${signal.action === 'buy' ? 'buy-signal' : signal.action === 'sell' ? 'sell-signal' : signal.action === 'wait' ? 'wait-signal' : ''}">${labels[signal.action] ?? 'Sin señal'}</div><div class="signal-state">${signal.text}</div></div>`;
  }).join('');
  $('bot-signals').innerHTML = cards;
}

function renderQuantFramework() {
  const portfolio = valueOfPortfolio();
  const btcPrice = state.quotes.BTC.price;
  const btcValue = portfolio / btcPrice;
  const btcPnl = btcValue - state.initialCash / assetFor('BTC').base;
  $('quant-portfolio-usd').textContent = money(portfolio);
  $('quant-pnl-usd').textContent = `${signedMoney(portfolio - state.initialCash)} USD de resultado simulado`;
  $('quant-portfolio-btc').textContent = `${btcValue.toFixed(8)} BTC`;
  $('quant-pnl-btc').textContent = `${btcPnl >= 0 ? '+' : '−'}${Math.abs(btcPnl).toFixed(8)} BTC de resultado · equivalencia según el precio disponible`;

  const hasHistory = Object.keys(state.datasets).length > 0;
  const modules = [
    ['1 · Técnico + order flow', liveMode ? 'Spot en vivo · velas 1 min, CVD y profundidad' : hasHistory ? 'Parcial · reglas OHLC en histórico' : 'Esperando datos', 'No incluye volume profile, absorción ni mapas de liquidaciones.'],
    ['2 · Análisis fundamental cripto', 'Pendiente', 'Faltan tokenomics verificados y datos financieros de protocolos.'],
    ['3 · Riesgo short cripto', 'Solo lectura de futuros', 'Funding y long/short orientan; no hay órdenes short ni liquidaciones simuladas.'],
    ['4 · On-chain y ballenas', 'No conectado', 'Hace falta una fuente on-chain con cobertura por red y atribución.'],
    ['5 · Noticias y sentimiento', 'No conectado', 'Hace falta un proveedor de noticias autorizado; no se interpreta ruido de redes como señal.'],
    ['6 · Riesgo de cartera', 'Parcial · cuenta virtual', 'Límite de pérdida demo del 4%; exposición y correlación aún básicas.'],
    ['7 · Momentum', liveMode ? 'Spot en vivo' : hasHistory ? 'Parcial · prueba histórica' : 'Esperando datos', 'Sin RVOL normalizado multi-exchange ni liquidaciones.'],
    ['8 · Selección cuantitativa', 'Parcial · BTC, ETH, SOL', 'No recorre todos los tokens ni screeners externos.'],
    ['Macro y eventos', 'No conectado', 'Sin calendario económico, regulación ni eventos de protocolo.'],
    ['Confluencia cripto', liveMode ? 'RSI/SMA + CVD/libro; futuros opcional' : 'Esperando fuentes en vivo', 'Regla reproducible; todavía no es aprendizaje automático ni se entrena con ganancias simuladas.']
  ];
  $('quant-modules').innerHTML = modules.map(([name, status, detail]) => `<article class="quant-module"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(status)}</span><small>${escapeHtml(detail)}</small></article>`).join('');

  const assetSelect = $('calc-asset');
  if (assetSelect && !assetSelect.options.length) assetSelect.innerHTML = markets.map((asset) => `<option value="${asset.symbol}">${asset.name} · ${asset.symbol}</option>`).join('');
  updateSizingEstimate();
}

function updateSizingEstimate() {
  const output = $('sizing-result');
  if (!output) return;
  const conviction = Number($('calc-conviction').value);
  const entry = Number($('calc-entry').value), stop = Number($('calc-stop').value);
  if (!Number.isFinite(conviction) || $('calc-conviction').value === '' || conviction < 0 || conviction > 100) {
    output.textContent = 'Introduce una convicción válida de 0 a 100. Sin datos verificables, deja el campo sin evaluar.';
    return;
  }
  if (conviction <= 65) {
    output.innerHTML = '<strong class="no-trade">NO OPERAR</strong><span>El filtro del marco exige convicción superior a 65%. La app no puede asignar esa convicción automáticamente.</span>';
    return;
  }
  if (!(entry > 0) || !(stop > 0) || entry === stop) {
    output.textContent = 'Introduce una entrada y un stop válidos para estimar el tamaño de posición.';
    return;
  }
  const side = $('calc-side').value;
  if ((side === 'long' && stop >= entry) || (side === 'short' && stop <= entry)) {
    output.textContent = side === 'long' ? 'Para una posición long, el stop debe quedar debajo de la entrada.' : 'Para una posición short, el stop debe quedar encima de la entrada.';
    return;
  }
  const riskFraction = Math.abs(entry - stop) / entry;
  const riskMin = conviction > 75 ? 5 : 3, riskMax = conviction > 75 ? 8 : 5;
  const exposureCap = valueOfPortfolio() * 0.15;
  const notionalMin = Math.min(riskMin / riskFraction, exposureCap);
  const notionalMax = Math.min(riskMax / riskFraction, exposureCap);
  const unitsMin = notionalMin / entry, unitsMax = notionalMax / entry;
  const btcPrice = state.quotes.BTC.price;
  const capApplied = (riskMax / riskFraction) > exposureCap;
  const tp1 = Number($('calc-tp1').value), tp2 = Number($('calc-tp2').value);
  const targetDirectionValid = side === 'long' ? tp1 > entry && tp2 > entry : tp1 > 0 && tp2 > 0 && tp1 < entry && tp2 < entry;
  const lossMin = notionalMin * riskFraction, lossMax = notionalMax * riskFraction;
  let targets = '';
  if (tp1 > 0 && tp2 > 0 && targetDirectionValid) {
    const returnFraction = 0.4 * Math.abs(tp1 - entry) / entry + 0.6 * Math.abs(tp2 - entry) / entry;
    targets = `<span>Objetivos brutos estimados con reparto 40% / 60%: ${money(notionalMin * returnFraction)}–${money(notionalMax * returnFraction)}; no incluyen comisiones ni deslizamiento.</span>`;
  } else {
    targets = '<span>Introduce TP1 y TP2 del lado correcto para estimar el reparto 40% / 60%.</span>';
  }
  output.innerHTML = `<strong>Tamaño estimado: ${money(notionalMin)}–${money(notionalMax)} USD</strong><span>Riesgo al stop: ${money(lossMin)}–${money(lossMax)} · distancia al stop ${(riskFraction * 100).toFixed(2)}% · exposición limitada al 15% de la cuenta demo${capApplied ? ' (límite aplicado)' : ''}.</span><span>Cantidad aproximada: ${qtyFormat(unitsMin)}–${qtyFormat(unitsMax)} ${escapeHtml($('calc-asset').value)} · equivalente ${ (notionalMin / btcPrice).toFixed(8) }–${(notionalMax / btcPrice).toFixed(8)} BTC al precio sintético actual.</span>${targets}<span class="no-trade">Estimación educativa: no envía órdenes. Las posiciones short no se pueden ejecutar en este simulador.</span>`;
}

function applyPaperOrder(symbol, side, quantity, price) {
  const gross = quantity * price, fee = gross * FEE_RATE;
  if (!(quantity > 0) || !Number.isFinite(gross)) return false;
  if (side === 'buy') {
    if (gross + fee > state.cash + 1e-8) return false;
    const position = state.positions[symbol] ?? { quantity: 0, averagePrice: 0 };
    const totalQuantity = position.quantity + quantity;
    position.averagePrice = (position.averagePrice * position.quantity + price * quantity) / totalQuantity;
    position.quantity = totalQuantity;
    state.positions[symbol] = position;
    state.cash -= gross + fee;
  } else {
    const position = state.positions[symbol];
    if (!position || quantity > position.quantity + 1e-10) return false;
    position.quantity -= quantity;
    if (position.quantity < 1e-10) delete state.positions[symbol];
    state.cash += gross - fee;
  }
  state.history.unshift({ id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, side, symbol, quantity, price, total: gross, fee, at: new Date().toISOString() });
  state.history = state.history.slice(0, 500);
  return true;
}

function evaluateBot() {
  if (!botActive) return;
  if (!liveMode || !streamConnected || !streamSubscribed) return;
  if (valueOfPortfolio() <= state.initialCash * 0.96) {
    botActive = false;
    showToast('Parada de riesgo: el bot se detuvo al alcanzar −4% en la cuenta demo.');
    return;
  }
  for (const asset of markets) {
    const symbol = asset.symbol, quote = state.quotes[symbol], position = state.positions[symbol];
    if (liveMode && (!quote.lastUpdate || Date.now() - quote.lastUpdate > 60000)) continue;
    const signal = getBotSignal(symbol); botSignals[symbol] = signal;
    const isBotPosition = Boolean(state.botManaged[symbol]);
    const stopHit = isBotPosition && position && quote.price <= position.averagePrice * 0.97;
    const cooldownDone = Date.now() - (botLastOrder[symbol] ?? 0) >= 32000;
    if (position && isBotPosition && (stopHit || signal.action === 'sell') && cooldownDone) {
      if (applyPaperOrder(symbol, 'sell', position.quantity, quote.price)) { delete state.botManaged[symbol]; botLastOrder[symbol] = Date.now(); }
      continue;
    }
    if (!position && signal.action === 'buy' && cooldownDone) {
      const equity = valueOfPortfolio();
      const exposure = Object.entries(state.positions).reduce((sum, [heldSymbol, held]) => sum + held.quantity * state.quotes[heldSymbol].price, 0);
      const orderValue = Math.min(equity * 0.15, equity * 0.60 - exposure, state.cash / (1 + FEE_RATE));
      if (orderValue >= 10 && applyPaperOrder(symbol, 'buy', orderValue / quote.price, quote.price)) { state.botManaged[symbol] = true; botLastOrder[symbol] = Date.now(); }
    }
  }
}

function renderAll() {
  renderMetrics(); renderFeatured(); renderPositions(); renderRecentActivity(); renderMarkets(); renderHistory(); renderHistoricalData(); renderAutomation(); renderQuantFramework(); renderLiveFeedStatus();
}

function renderLiveFeedStatus(message) {
  const status = $('live-feed-status');
  if (!status) return;
  status.classList.toggle('connected', liveMode);
  status.innerHTML = `<i></i> ${message ?? (streamConnected ? 'EN VIVO' : liveMode ? 'COTIZACIONES' : 'DESCONECTADO')}`;
  $('disconnect-live-feed').disabled = !(liveSocket || liveConnecting);
  $('connect-live-feed').disabled = Boolean(liveSocket || liveConnecting);
  const topStatus = document.querySelector('.market-status');
  if (topStatus) topStatus.innerHTML = `<i></i> ${streamSubscribed ? 'Binance Spot en vivo' : liveMode ? 'Conectando Binance Spot' : 'Binance desconectado'}`;
  const marketTag = document.querySelector('#markets-view .simulated-tag');
  if (marketTag) marketTag.innerHTML = `<i></i> ${liveMode ? 'Binance Spot · real' : 'Conectar para operar'}`;
  const marketDescription = $('market-description');
  if (marketDescription) marketDescription.textContent = liveMode ? 'Precios reales de Binance Spot; las operaciones son ficticias.' : 'Conecta Binance para cargar precios reales y operar en modo demo.';
  const changeHeading = $('change-heading');
  if (changeHeading) changeHeading.textContent = liveMode ? 'VS. CIERRE PREVIO' : 'CAMBIO';
  const banner = document.querySelector('.automation-banner>div>span');
  if (banner) banner.textContent = `Fuente: ${liveMode ? 'Binance Spot en tiempo real' : 'esperando conexión a Binance'}. Se simulan solo las órdenes y el saldo; no se envían operaciones a ningún exchange.`;
  const context = $('futures-context');
  if (context && Object.keys(futuresContext).length) context.innerHTML = `<strong>Futuros Binance · solo contexto, sin apalancamiento</strong><span>${Object.entries(futuresContext).map(([symbol, row]) => `${symbol}: funding ${(Number(row.funding) * 100).toFixed(4)}% · OI ${Number(row.oi).toLocaleString('en-US')} · long/short ${Number(row.ratio).toFixed(2)}`).join('　|　')} · consulta ${new Date().toLocaleTimeString('es-MX')}</span>`;
}

async function connectLiveFeed() {
  liveConnecting = true;
  liveMode = false;
  streamConnected = false;
  streamSubscribed = false;
  pendingLiveQuotes = {};
  if (botActive) { botActive = false; botSignals = {}; }
  renderLiveFeedStatus('CONECTANDO');
  $('live-feed-note').textContent = 'Conectando al feed público de Binance Spot…';
  try {
    const snapshots = await Promise.all(markets.map(async (asset) => {
      const pair = providerSymbols[asset.symbol].toUpperCase();
      const [response, candlesResponse] = await Promise.all([
        fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${pair}`),
        fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=1m&limit=200`)
      ]);
      if (!response.ok) throw new Error(`No se pudo obtener ${asset.symbol} (${response.status}).`);
      const data = await response.json();
      if (!candlesResponse.ok) throw new Error(`No se pudo obtener el historial de ${asset.symbol}.`);
      const candleRows = await candlesResponse.json();
      const price = Number(data.lastPrice);
      if (!Number.isFinite(price) || price <= 0) throw new Error(`No hay cotización disponible para ${asset.symbol}.`);
      return { asset, price, previousClose: Number(data.openPrice), timestamp: Number(data.closeTime) || Date.now(), closes: candleRows.filter((row) => Number(row[6]) < Date.now()).map((row) => Number(row[4])).filter((close) => close > 0) };
    }));
    if (!liveConnecting) return;
    for (const item of snapshots) {
      const quote = state.quotes[item.asset.symbol];
      quote.price = item.price;
      quote.dayOpen = item.previousClose > 0 ? item.previousClose : item.price;
      quote.lastUpdate = item.timestamp;
      quote.source = 'live';
      quote.priceHistory = [];
      quote.priceHistory = item.closes;
      quote.cvd = 0; quote.flowWindow = []; quote.bookImbalance = Number.NaN;
      quote.points = [0];
    }
    liveMode = true;
    liveLastUpdate = Date.now();
    save();
    const streams = Object.values(providerSymbols).flatMap((pair) => [`${pair}@trade`, `${pair}@kline_1m`, `${pair}@depth5@100ms`]).join('/');
    const socket = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    liveSocket = socket;
    liveConnecting = false;
    renderAll();
  socket.addEventListener('open', () => {
    if (liveSocket !== socket) return;
    streamConnected = true;
    streamSubscribed = true;
    renderLiveFeedStatus('EN VIVO');
    updateFuturesContext();
    futuresTimer = window.setInterval(updateFuturesContext, 60000);
  });
  socket.addEventListener('message', (message) => {
    if (liveSocket !== socket) return;
    let data;
    try { data = JSON.parse(message.data); } catch { return; }
    const payload = data.data;
    const stream = String(data.stream || '').toLowerCase();
    const symbol = Object.keys(providerSymbols).find((item) => stream.startsWith(providerSymbols[item]));
    if (!symbol) return;
    const quote = state.quotes[symbol];
    if (stream.endsWith('@trade')) {
      const price = Number(payload?.p);
      if (!(price > 0)) return;
      const previous = quote.price;
      quote.price = price; quote.source = 'live'; quote.lastUpdate = Number(payload.T) || Date.now();
      const tradeNotional = price * Number(payload.q || 0);
      quote.flowWindow ??= [];
      quote.flowWindow.push(payload.m ? -tradeNotional : tradeNotional);
      if (quote.flowWindow.length > 300) quote.flowWindow.shift();
      quote.cvd = quote.flowWindow.reduce((sum, value) => sum + value, 0);
      quote.points.push(quote.points.at(-1) + (price / previous - 1) * 90);
      if (quote.points.length > 12) quote.points.shift();
    } else if (stream.endsWith('@kline_1m') && payload?.k?.x) {
      quote.priceHistory.push(Number(payload.k.c));
      if (quote.priceHistory.length > 300) quote.priceHistory.shift();
      botSignals[symbol] = getBotSignal(symbol);
      evaluateBot();
    } else if (stream.includes('@depth5')) {
      const bid = (payload?.bids || []).reduce((sum, row) => sum + Number(row[0]) * Number(row[1]), 0);
      const ask = (payload?.asks || []).reduce((sum, row) => sum + Number(row[0]) * Number(row[1]), 0);
      quote.bookImbalance = bid + ask ? (bid - ask) / (bid + ask) : 0;
    }
    liveLastUpdate = Date.now();
    if (Date.now() - lastLiveUiUpdate >= 1000) {
      lastLiveUiUpdate = Date.now(); save(); renderAll();
      if ($('trade-modal').classList.contains('open')) refreshOrderPreview();
    }
  });
  socket.addEventListener('error', () => { if (liveSocket === socket) disconnectLiveFeed('No se pudo conectar al feed de Binance. Revisa tu conexión.'); });
  socket.addEventListener('close', () => { if (liveSocket === socket) disconnectLiveFeed('La conexión se cerró.'); });
  } catch (error) {
    if (!liveConnecting) return;
    disconnectLiveFeed(`${error.message || 'No se pudo iniciar el feed.'} Comprueba tu conexión a internet.`);
  }
}

function disconnectLiveFeed(reason = '') {
  if (liveHeartbeat) clearInterval(liveHeartbeat);
  liveHeartbeat = null;
  if (futuresTimer) clearInterval(futuresTimer);
  futuresTimer = null; futuresContext = {};
  const socket = liveSocket; liveSocket = null; liveMode = false; streamConnected = false; streamSubscribed = false; liveConnecting = false; pendingLiveQuotes = {};
  if (botActive) { botActive = false; botSignals = {}; }
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  for (const asset of markets) { const quote = state.quotes[asset.symbol]; delete quote.source; delete quote.lastUpdate; }
  save(); renderAll();
  $('live-feed-note').textContent = reason ? `${reason} El bot se detuvo; no se cambiarán los precios a valores ficticios.` : 'Desconectado. El bot queda detenido hasta reconectar con Binance Spot.';
}

async function updateFuturesContext() {
  const next = {};
  await Promise.all(Object.entries(providerSymbols).map(async ([symbol, pair]) => {
    try {
      const [premium, interest, ratio] = await Promise.all([
        fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${pair.toUpperCase()}`).then((response) => response.json()),
        fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair.toUpperCase()}`).then((response) => response.json()),
        fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${pair.toUpperCase()}&period=5m&limit=1`).then((response) => response.json())
      ]);
      if (Number.isFinite(Number(premium.lastFundingRate)) && Number(interest.openInterest) > 0 && Array.isArray(ratio) && ratio[0]) next[symbol] = { funding: Number(premium.lastFundingRate), oi: Number(interest.openInterest), ratio: Number(ratio[0].longShortRatio) };
    } catch { /* Si los futuros no están disponibles, el spot sigue funcionando sin inventar métricas. */ }
  }));
  futuresContext = next; renderLiveFeedStatus();
}

function setView(view) {
  if (!['overview', 'markets', 'automation', 'activity'].includes(view)) view = 'overview';
  activeView = view;
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active-view', section.id === `${view}-view`));
  document.querySelectorAll('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.view === view));
  $('breadcrumb-current').textContent = view === 'overview' ? 'Resumen' : view === 'markets' ? 'Mercados' : view === 'automation' ? 'Automatización' : 'Actividad';
  $('sidebar').classList.remove('open');
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
}

function refreshOrderPreview() {
  const symbol = $('trade-asset').value;
  const asset = assetFor(symbol);
  if (!asset) return;
  $('trade-quote').textContent = priceMarkup(symbol);
  $('trade-symbol').textContent = symbol;
  const quantity = Number($('trade-quantity').value) || 0;
  const estimate = quantity * state.quotes[symbol].price;
  $('order-total').textContent = money(estimate + (tradeSide === 'buy' ? estimate * FEE_RATE : -estimate * FEE_RATE));
  $('form-error').textContent = '';
  const position = state.positions[symbol];
  $('trade-quantity').max = tradeSide === 'sell' ? String(position?.quantity ?? 0) : '';
  $('submit-order').textContent = `Confirmar ${tradeSide === 'buy' ? 'compra' : 'venta'} simulada`;
  $('submit-order').classList.toggle('sell-order', tradeSide === 'sell');
}

function openTrade(symbol = markets[0].symbol, side = 'buy') {
  if (!liveMode || !streamConnected) { showToast('Conecta Binance Spot para operar con precios reales.'); return; }
  tradeSide = side;
  $('trade-asset').innerHTML = markets.map((asset) => `<option value="${asset.symbol}">${asset.name} · ${asset.pair}</option>`).join('');
  $('trade-asset').value = assetFor(symbol) ? symbol : markets[0].symbol;
  $('trade-quantity').value = '';
  document.querySelectorAll('.order-tab').forEach((tab) => tab.classList.toggle('selected', tab.dataset.side === side));
  $('trade-modal').classList.add('open');
  $('trade-modal').setAttribute('aria-hidden', 'false');
  refreshOrderPreview();
  $('trade-quantity').focus();
}

function closeTrade() {
  $('trade-modal').classList.remove('open');
  $('trade-modal').setAttribute('aria-hidden', 'true');
}

function executeTrade(event) {
  event.preventDefault();
  if (!liveMode || !streamConnected) { $('form-error').textContent = 'Conecta Binance Spot para usar una cotización real.'; return; }
  const symbol = $('trade-asset').value;
  const quantity = Number($('trade-quantity').value);
  const price = state.quotes[symbol]?.price;
  const gross = quantity * price;
  const fee = gross * FEE_RATE;
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(gross)) { $('form-error').textContent = 'Escribe una cantidad válida mayor que cero.'; return; }
  if (tradeSide === 'buy') {
    if (gross + fee > state.cash + 1e-8) { $('form-error').textContent = `Efectivo insuficiente. Disponible: ${money(state.cash)}.`; return; }
    const oldPosition = state.positions[symbol] ?? { quantity: 0, averagePrice: 0 };
    const newQuantity = oldPosition.quantity + quantity;
    oldPosition.averagePrice = (oldPosition.averagePrice * oldPosition.quantity + price * quantity) / newQuantity;
    oldPosition.quantity = newQuantity;
    state.positions[symbol] = oldPosition;
    state.cash -= gross + fee;
  } else {
    const position = state.positions[symbol];
    if (!position || quantity > position.quantity + 1e-10) { $('form-error').textContent = `Cantidad superior a tu posición. Disponible: ${qtyFormat(position?.quantity ?? 0)} ${symbol}.`; return; }
    position.quantity -= quantity;
    if (position.quantity < 1e-10) delete state.positions[symbol];
    state.cash += gross - fee;
  }
  state.history.unshift({ id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, side: tradeSide, symbol, quantity, price, total: gross, fee, at: new Date().toISOString() });
  state.history = state.history.slice(0, 500);
  save(); renderAll(); closeTrade();
  showToast(`${tradeSide === 'buy' ? 'Compra' : 'Venta'} simulada registrada · ${qtyFormat(quantity)} ${symbol}`);
}

function showToast(message) {
  const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2700);
}

function tickQuotes() {
  if (!liveMode || !streamConnected || !streamSubscribed) return;
  for (const asset of markets) {
    const quote = state.quotes[asset.symbol];
    botSignals[asset.symbol] = getBotSignal(asset.symbol);
    evaluateBot();
  }
  save(); renderAll();
  if ($('trade-modal').classList.contains('open')) refreshOrderPreview();
}

function exportCsv() {
  if (!state.history.length) { showToast('No hay operaciones para exportar.'); return; }
  const rows = [['fecha', 'tipo', 'activo', 'cantidad', 'precio_usd', 'valor_usd', 'comision_usd'], ...state.history.map((trade) => [trade.at, trade.side === 'buy' ? 'compra' : 'venta', trade.symbol, trade.quantity, trade.price, trade.total, trade.fee])];
  const csv = '\uFEFF' + rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = `deusbot-actividad-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
}

function setup() {
  $('current-date').textContent = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date());
  document.querySelectorAll('[data-view], [data-go-view]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); setView(link.dataset.view ?? link.dataset.goView); }));
  document.addEventListener('click', (event) => {
    const tradeButton = event.target.closest('[data-trade]');
    if (tradeButton) openTrade(tradeButton.dataset.trade);
  });
  document.querySelectorAll('.order-tab').forEach((tab) => tab.addEventListener('click', () => {
    tradeSide = tab.dataset.side;
    document.querySelectorAll('.order-tab').forEach((item) => item.classList.toggle('selected', item === tab));
    $('trade-quantity').value = '';
    refreshOrderPreview();
  }));
  $('open-trade').addEventListener('click', () => openTrade());
  $('close-trade').addEventListener('click', closeTrade);
  $('trade-modal').addEventListener('click', (event) => { if (event.target === $('trade-modal')) closeTrade(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeTrade(); });
  $('trade-form').addEventListener('submit', executeTrade);
  $('trade-asset').addEventListener('change', refreshOrderPreview);
  $('trade-quantity').addEventListener('input', refreshOrderPreview);
  $('market-search').addEventListener('input', renderMarkets);
  $('tv-load').addEventListener('click', loadTradingViewChart);
  $('tv-symbol').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadTradingViewChart(); });
  $('market-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]'); if (!button) return;
    activeFilter = button.dataset.filter;
    document.querySelectorAll('.filter-button').forEach((item) => item.classList.toggle('selected', item === button));
    renderMarkets();
  });
  $('export-button').addEventListener('click', exportCsv);
  $('history-asset').addEventListener('change', renderHistoricalData);
  $('sizing-tool').addEventListener('input', updateSizingEstimate);
  $('sizing-tool').addEventListener('change', updateSizingEstimate);
  $('download-history').addEventListener('click', downloadHistory);
  $('import-history').addEventListener('click', () => $('history-file').click());
  $('history-file').addEventListener('change', () => { const file = $('history-file').files?.[0]; if (file) importHistoricalCsv(file); });
  $('run-backtest').addEventListener('click', compareHistoricalStrategies);
  $('connect-live-feed').addEventListener('click', connectLiveFeed);
  $('disconnect-live-feed').addEventListener('click', () => disconnectLiveFeed());
  $('strategy-select').addEventListener('change', () => {
    state.botStrategy = $('strategy-select').value;
    botSignals = {};
    save(); renderAutomation();
  });
  $('bot-toggle').addEventListener('click', () => {
    if (!botActive && (!liveMode || !streamConnected || !streamSubscribed)) { showToast('Conecta Binance Spot antes de iniciar el bot.'); return; }
    botActive = !botActive;
    renderAutomation();
    showToast(botActive ? 'Automatización iniciada en modo paper trading.' : 'Automatización pausada.');
  });
  $('reset-button').addEventListener('click', () => {
    if (!window.confirm('¿Reiniciar la cuenta demo? Se borrarán el historial y las posiciones guardadas en este navegador.')) return;
    botActive = false; botSignals = {}; botLastOrder = {};
    state = freshState(); save(); renderAll(); showToast('Cuenta demo reiniciada.');
  });
  $('menu-button').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  const initialView = location.hash.slice(1);
  setView(['overview', 'markets', 'automation', 'activity'].includes(initialView) ? initialView : 'overview');
  renderAll();
  renderLiveFeedStatus();
  refreshTradingViewSignals();
  window.setInterval(refreshTradingViewSignals, 10000);
  window.setInterval(tickQuotes, 8000);
  window.setTimeout(connectLiveFeed, 350);
  window.addEventListener('pagehide', () => {
    if (liveHeartbeat) clearInterval(liveHeartbeat);
    if (futuresTimer) clearInterval(futuresTimer);
    if (liveSocket && liveSocket.readyState < WebSocket.CLOSING) liveSocket.close();
  });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

setup();
