/**
 * Minimal Chrome DevTools Protocol client over Node's built-in WebSocket, plus a
 * static file server for the fixtures. No dependencies, same as the rest of the
 * tooling.
 *
 * Extended past a plain request/response client in one way that matters here:
 * it dispatches protocol EVENTS as well as command replies, which is what makes
 * the Fetch domain usable. Mocking the Discord API at the network layer is the
 * only way to exercise the real client end to end without pointing it at a real
 * account.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * Edge first, on purpose.
 *
 * Branded Google Chrome refuses --load-extension and --disable-extensions-except
 * ("--disable-extensions-except is not allowed in Google Chrome, ignoring." in
 * its own log) and then carries on without the extension, so the suite would
 * appear to run and prove nothing. Edge and Chromium are the same engine and
 * still honour the flags. Chrome stays last as a deliberate fallback.
 */
export const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Chromium/Application/chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function httpJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`bad JSON from ${urlPath}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
  });
}

export async function waitFor(label, fn, { timeout = 30000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function serveDir(dir) {
  const server = http.createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const file = path.join(dir, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'text/plain' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

export class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        return;
      }
      // Events carry no id. Without this branch the Fetch domain is unusable,
      // because every paused request arrives as an event and nothing else.
      if (msg.method) {
        const list = this.handlers.get(msg.method);
        if (list) for (const fn of list) fn(msg.params, msg.sessionId);
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });
    return new CDP(socket);
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  async evaluate(sessionId, expression) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)
      );
    }
    return result.result.value;
  }
}

/**
 * Stand a fake Discord API in front of one target.
 *
 * `resolve(method, path)` returns either a plain object to send back as JSON, a
 * {status, headers, body} for finer control, or null to let the request through
 * to the real network. Every intercepted call is recorded so a test can assert
 * on ordering and timing, which is how the pacing gets proved against the real
 * client rather than against the limiter in isolation.
 */
export async function mockApi(cdp, sessionId, resolve) {
  const calls = [];

  cdp.on('Fetch.requestPaused', async (params, from) => {
    if (from !== sessionId) return;
    const { requestId, request } = params;
    const url = new URL(request.url);
    const at = Date.now();

    let reply;
    try {
      reply = resolve(request.method, url.pathname + url.search, request);
    } catch (err) {
      reply = { status: 500, body: { message: String(err) } };
    }

    if (reply === null || reply === undefined) {
      await cdp.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
      return;
    }

    calls.push({ method: request.method, path: url.pathname + url.search, at });

    const status = reply.status || 200;
    const headers = Object.entries(reply.headers || {}).map(([name, value]) => ({
      name,
      value: String(value),
    }));
    headers.push({ name: 'Content-Type', value: 'application/json' });
    // The client fetches cross-origin from the extension page, so without CORS
    // headers the response is opaque and every assertion fails for the wrong
    // reason.
    headers.push({ name: 'Access-Control-Allow-Origin', value: '*' });

    const bodyText =
      reply.body === null || reply.body === undefined
        ? ''
        : typeof reply.body === 'string'
          ? reply.body
          : JSON.stringify(reply.body);

    await cdp
      .send(
        'Fetch.fulfillRequest',
        {
          requestId,
          responseCode: status,
          responseHeaders: headers,
          body: Buffer.from(bodyText, 'utf8').toString('base64'),
        },
        sessionId
      )
      .catch(() => {});
  });

  await cdp.send(
    'Fetch.enable',
    { patterns: [{ urlPattern: 'https://discord.com/api/*' }] },
    sessionId
  );

  return calls;
}

export async function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error('No Chromium-based browser found.');
}

export async function launchWithExtension({ port, dir, headless = true }) {
  const binary = await findBrowser();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'clearline-e2e-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${dir}`,
    `--disable-extensions-except=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--window-size=1200,900',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const child = spawn(binary, args, { stdio: 'ignore' });
  await waitFor('devtools endpoint', () => httpJson(port, '/json/version'), { timeout: 25000 });
  return { child, profile, binary };
}

export async function shutdown(session) {
  try {
    session?.child.kill();
  } catch {
    /* already exited */
  }
  await sleep(300);
  if (session?.profile) {
    await fs.rm(session.profile, { recursive: true, force: true }).catch(() => {});
  }
}
