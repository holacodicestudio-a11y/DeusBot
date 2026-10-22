import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 3000);
const webhookToken = process.env.TV_WEBHOOK_TOKEN || '';
const maxBodyBytes = 16 * 1024;
const signals = [];
const publicFiles = new Set(['index.html', 'styles.css', 'styles-quant.css', 'app.js', 'manifest.webmanifest', 'sw.js', 'icons/automaton.svg']);
let rateWindowStarted = Date.now();
let requestCount = 0;
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function reply(res, status, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(body);
}

function safeTokenMatches(candidate) {
  const actual = Buffer.from(webhookToken);
  const supplied = Buffer.from(candidate);
  return actual.length >= 32 && supplied.length === actual.length && timingSafeEqual(actual, supplied);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!req.headers['content-type']?.toLowerCase().includes('application/json')) throw Object.assign(new Error('Expected application/json'), { status: 415 });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function normalizeSignal(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const symbol = typeof payload.symbol === 'string' ? payload.symbol.trim().toUpperCase() : '';
  const action = typeof payload.action === 'string' ? payload.action.trim().toLowerCase() : '';
  const price = Number(payload.price);
  const interval = typeof payload.interval === 'string' ? payload.interval.slice(0, 12) : '';
  const eventTime = typeof payload.time === 'string' ? payload.time.slice(0, 64) : '';
  if (!/^[A-Z0-9._-]{1,32}:[A-Z0-9._-]{1,32}$/.test(symbol)) return null;
  if (!['buy', 'sell', 'long', 'short', 'wait'].includes(action)) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  return { id: randomUUID(), symbol, action, price, interval, eventTime, receivedAt: new Date().toISOString(), source: 'TradingView' };
}

function staticFile(req, res, pathname) {
  let requested;
  try { requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)); }
  catch { return reply(res, 404, 'Not found'); }
  if (!requested || requested.includes('\\') || requested.split('/').some((part) => part.startsWith('.'))) return reply(res, 404, 'Not found');
  if (!publicFiles.has(requested)) return reply(res, 404, 'Not found');
  const filePath = resolve(projectRoot, requested);
  if (!filePath.startsWith(projectRoot + sep)) return reply(res, 404, 'Not found');
  let info;
  try { info = statSync(filePath); } catch { return reply(res, 404, 'Not found'); }
  if (!info.isFile()) return reply(res, 404, 'Not found');
  res.writeHead(200, { 'content-type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream', 'content-length': info.size, 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (Date.now() - rateWindowStarted >= 60_000) { rateWindowStarted = Date.now(); requestCount = 0; }
  requestCount += 1;
  if (requestCount > 180) return reply(res, 429, { error: 'rate_limited' });

  if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true, service: 'deusbot-tradingview', webhookConfigured: webhookToken.length >= 32 });
  if (req.method === 'GET' && url.pathname === '/api/tradingview/signals') return reply(res, 200, { signals: signals.slice(0, 50) });
  if (url.pathname.startsWith('/api/tradingview/webhook/')) {
    if (req.method !== 'POST') return reply(res, 405, { error: 'method_not_allowed' });
    if (!webhookToken) return reply(res, 503, { error: 'webhook_not_configured' });
    const suppliedToken = url.pathname.slice('/api/tradingview/webhook/'.length);
    if (!safeTokenMatches(suppliedToken)) return reply(res, 401, { error: 'unauthorized' });
    try {
      const signal = normalizeSignal(await readJson(req));
      if (!signal) return reply(res, 422, { error: 'invalid_signal' });
      signals.unshift(signal);
      if (signals.length > 200) signals.length = 200;
      return reply(res, 202, { accepted: true, id: signal.id });
    } catch (error) { return reply(res, error.status || 400, { error: error.status === 413 ? 'payload_too_large' : error.status === 415 ? 'content_type_required' : 'invalid_request' }); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'method_not_allowed' });
  return staticFile(req, res, url.pathname);
});

server.listen(port, '0.0.0.0', () => console.log(`DeusBot service listening on ${port}`));
