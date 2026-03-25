#!/usr/bin/env node
// Persistent Chrome DevTools Protocol CLI.
// Keeps a single browser-level daemon alive and reuses target sessions so
// repeated commands do not keep triggering the Chrome approval prompt.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import net from 'net';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  formatPageList,
  getPagesCachePath,
  getIpcPath,
  readBrowserWsUrl,
  resolvePrefix,
} from './cdp-core.mjs';

const TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 40;
const DAEMON_CONNECT_DELAY = 200;
const IPC_PATH = getIpcPath();
const PAGES_CACHE = getPagesCachePath();
const SCRIPT_PATH = fileURLToPath(import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
  #ws;
  #id = 0;
  #pending = new Map();
  #eventHandlers = new Map();
  #closeHandlers = [];

  async connect(wsUrl) {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => resolve();
      this.#ws.onerror = (event) => reject(new Error('WebSocket error: ' + (event.message || event.type)));
      this.#ws.onclose = () => this.#closeHandlers.forEach((handler) => handler());
      this.#ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id && this.#pending.has(message.id)) {
          const { resolve, reject } = this.#pending.get(message.id);
          this.#pending.delete(message.id);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
          return;
        }
        if (message.method && this.#eventHandlers.has(message.method)) {
          for (const handler of [...this.#eventHandlers.get(message.method)]) {
            handler(message.params || {}, message);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.#ws.send(JSON.stringify(message));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, TIMEOUT);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) {
    this.#closeHandlers.push(handler);
  }

  close() {
    this.#ws.close();
  }
}

async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter((target) => target.type === 'page' && !target.url.startsWith('chrome://'));
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sessionId, compact = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sessionId);
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  const roots = nodes.filter((node) => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return lines.join('\n');
}

async function evalStr(cdp, sessionId, expression) {
  await cdp.send('Runtime.enable', {}, sessionId);
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const value = result.result.value;
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '');
}

async function shotStr(cdp, sessionId, filePath) {
  let dpr = 1;
  try {
    const raw = await evalStr(cdp, sessionId, 'window.devicePixelRatio');
    const parsed = parseFloat(raw);
    if (parsed > 0) dpr = parsed;
  } catch {}

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const output = filePath || '/tmp/screenshot.png';
  writeFileSync(output, Buffer.from(data, 'base64'));

  return [
    output,
    `Screenshot saved. Device pixel ratio (DPR): ${dpr}`,
    'Coordinate mapping:',
    `  Screenshot pixels → CSS pixels: divide by ${dpr}`,
  ].join('\n');
}

async function htmlStr(cdp, sessionId, selector) {
  const expression = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : 'document.documentElement.outerHTML';
  return evalStr(cdp, sessionId, expression);
}

async function waitForDocumentReady(cdp, sessionId, timeoutMs = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sessionId, 'document.readyState');
      lastState = state;
      if (state === 'complete') return;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

async function navStr(cdp, sessionId, url) {
  await cdp.send('Page.enable', {}, sessionId);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url }, sessionId);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sessionId, 5000);
  return `Navigated to ${url}`;
}

async function netStr(cdp, sessionId) {
  const raw = await evalStr(cdp, sessionId, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map((entry) => (
    `${String(entry.duration).padStart(5)}ms  ${String(entry.size || '?').padStart(8)}B  ${entry.type.padEnd(8)}  ${entry.name}`
  )).join('\n');
}

async function clickStr(cdp, sessionId, selector) {
  if (!selector) throw new Error('CSS selector required');
  const expression = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sessionId, expression);
  const parsed = JSON.parse(result);
  if (!parsed.ok) throw new Error(parsed.error);
  return `Clicked <${parsed.tag}> "${parsed.text}"`;
}

async function clickXyStr(cdp, sessionId, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sessionId);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sessionId);
  return `Clicked at CSS (${cx}, ${cy})`;
}

async function typeStr(cdp, sessionId, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sessionId);
  return `Typed ${text.length} characters`;
}

async function loadAllStr(cdp, sessionId, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sessionId, `!!document.querySelector(${JSON.stringify(selector)})`);
    if (exists !== 'true') break;
    const clickExpression = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
    const clicked = await evalStr(cdp, sessionId, clickExpression);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

async function evalRawStr(cdp, sessionId, method, paramsJson) {
  if (!method) throw new Error('CDP method required');
  let params = {};
  if (paramsJson) {
    try {
      params = JSON.parse(paramsJson);
    } catch {
      throw new Error(`Invalid JSON params: ${paramsJson}`);
    }
  }
  const result = await cdp.send(method, params, sessionId);
  return JSON.stringify(result, null, 2);
}

async function runDaemon() {
  const { wsUrl, portFile } = readBrowserWsUrl();
  const cdp = new CDP();
  await cdp.connect(wsUrl);

  const sessionsByTarget = new Map();
  const targetsBySession = new Map();
  let alive = true;
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);

  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  }

  function forgetSession({ sessionId, targetId }) {
    const resolvedTargetId = targetId || targetsBySession.get(sessionId);
    const resolvedSessionId = sessionId || sessionsByTarget.get(targetId);
    if (resolvedTargetId) sessionsByTarget.delete(resolvedTargetId);
    if (resolvedSessionId) targetsBySession.delete(resolvedSessionId);
  }

  function shutdown() {
    if (!alive) return;
    alive = false;
    clearTimeout(idleTimer);
    try { server.close(); } catch {}
    if (process.platform !== 'win32') {
      try { unlinkSync(IPC_PATH); } catch {}
    }
    cdp.close();
    process.exit(0);
  }

  async function getSession(targetId) {
    if (sessionsByTarget.has(targetId)) return sessionsByTarget.get(targetId);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionsByTarget.set(targetId, sessionId);
    targetsBySession.set(sessionId, targetId);
    return sessionId;
  }

  cdp.onEvent('Target.targetDestroyed', ({ targetId }) => forgetSession({ targetId }));
  cdp.onEvent('Target.detachedFromTarget', ({ sessionId }) => forgetSession({ sessionId }));
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  async function handleCommand({ cmd, args = [] }) {
    resetIdle();
    switch (cmd) {
      case 'list': {
        const pages = await getPages(cdp);
        writeFileSync(PAGES_CACHE, JSON.stringify(pages));
        return { ok: true, result: formatPageList(pages) };
      }
      case 'list_raw': {
        const pages = await getPages(cdp);
        writeFileSync(PAGES_CACHE, JSON.stringify(pages));
        return { ok: true, result: JSON.stringify(pages) };
      }
      case 'status': {
        return {
          ok: true,
          result: JSON.stringify({
            portFile,
            attachedTargets: [...sessionsByTarget.keys()],
          }),
        };
      }
      case 'stop': {
        return { ok: true, result: 'stopped', stopAfter: true };
      }
      default:
        break;
    }

    const [targetId, ...commandArgs] = args;
    if (!targetId) return { ok: false, error: 'target ID required' };

    try {
      const sessionId = await getSession(targetId);
      let result;
      switch (cmd) {
        case 'snap':
        case 'snapshot':
          result = await snapshotStr(cdp, sessionId, true);
          break;
        case 'eval':
          result = await evalStr(cdp, sessionId, commandArgs[0]);
          break;
        case 'shot':
        case 'screenshot':
          result = await shotStr(cdp, sessionId, commandArgs[0]);
          break;
        case 'html':
          result = await htmlStr(cdp, sessionId, commandArgs[0]);
          break;
        case 'nav':
        case 'navigate':
          result = await navStr(cdp, sessionId, commandArgs[0]);
          break;
        case 'net':
        case 'network':
          result = await netStr(cdp, sessionId);
          break;
        case 'click':
          result = await clickStr(cdp, sessionId, commandArgs[0]);
          break;
        case 'clickxy':
          result = await clickXyStr(cdp, sessionId, commandArgs[0], commandArgs[1]);
          break;
        case 'type':
          result = await typeStr(cdp, sessionId, commandArgs[0]);
          break;
        case 'loadall':
          result = await loadAllStr(cdp, sessionId, commandArgs[0], commandArgs[1] ? parseInt(commandArgs[1], 10) : 1500);
          break;
        case 'evalraw':
          result = await evalRawStr(cdp, sessionId, commandArgs[0], commandArgs[1]);
          break;
        default:
          return { ok: false, error: `Unknown command: ${cmd}` };
      }
      return { ok: true, result: result ?? '' };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  if (process.platform !== 'win32') {
    try { unlinkSync(IPC_PATH); } catch {}
  }

  const server = net.createServer((connection) => {
    let buffer = '';
    connection.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          connection.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        handleCommand(request).then((response) => {
          const payload = JSON.stringify({ ...response, id: request.id ?? 1 }) + '\n';
          if (response.stopAfter) connection.end(payload, shutdown);
          else connection.write(payload);
        });
      }
    });
  });

  server.listen(IPC_PATH);
}

function connectToDaemon() {
  return new Promise((resolve, reject) => {
    const connection = net.connect(IPC_PATH);
    connection.on('connect', () => resolve(connection));
    connection.on('error', reject);
  });
}

async function sendCommand(connection, request) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const cleanup = () => {
      connection.off('data', onData);
      connection.off('error', onError);
      connection.off('end', onEnd);
      connection.off('close', onClose);
    };

    const onData = (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return;
      settled = true;
      cleanup();
      resolve(JSON.parse(buffer.slice(0, newlineIndex)));
      connection.end();
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    const onClose = onEnd;

    connection.on('data', onData);
    connection.on('error', onError);
    connection.on('end', onEnd);
    connection.on('close', onClose);
    connection.write(JSON.stringify({ ...request, id: 1 }) + '\n');
  });
}

async function ensureDaemon() {
  try {
    const connection = await connectToDaemon();
    await sendCommand(connection, { cmd: 'status' });
    return;
  } catch {}

  const child = spawn(process.execPath, [SCRIPT_PATH, '--daemon'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try {
      const connection = await connectToDaemon();
      await sendCommand(connection, { cmd: 'status' });
      return;
    } catch {}
  }
  throw new Error('Daemon failed to start — approve Chrome debugging if prompted.');
}

function loadCachedPages() {
  if (!existsSync(PAGES_CACHE)) return null;
  return JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
}

const USAGE = `cdp - persistent Chrome DevTools Protocol CLI

Usage: cdp <command> [args]

  list                              List open pages
  snap  <target>                    Accessibility tree snapshot
  eval  <target> <expr>             Evaluate JavaScript
  shot  <target> [file]             Screenshot (default: /tmp/screenshot.png)
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url>              Navigate and wait for load completion
  net   <target>                    Network performance entries
  click   <target> <selector>       Click an element by CSS selector
  clickxy <target> <x> <y>          Click at CSS pixel coordinates
  type    <target> <text>           Type text at current focus
  loadall <target> <selector> [ms]  Repeatedly click a load-more selector
  evalraw <target> <method> [json]  Send a raw CDP command
  stop                              Stop the background daemon

The daemon reuses attached target sessions so repeated commands on the same tab
should not keep triggering Chrome approval prompts.
`;

const NEEDS_TARGET = new Set([
  'snap', 'snapshot', 'eval', 'shot', 'screenshot', 'html', 'nav', 'navigate',
  'net', 'network', 'click', 'clickxy', 'type', 'loadall', 'evalraw',
]);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === '--daemon') {
    await runDaemon();
    return;
  }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return;
  }

  await ensureDaemon();

  if (cmd === 'list' || cmd === 'ls') {
    const connection = await connectToDaemon();
    const response = await sendCommand(connection, { cmd: 'list' });
    if (!response.ok) throw new Error(response.error);
    if (response.result) console.log(response.result);
    return;
  }

  if (cmd === 'stop') {
    const connection = await connectToDaemon();
    const response = await sendCommand(connection, { cmd: 'stop' });
    if (!response.ok) throw new Error(response.error);
    if (response.result) console.log(response.result);
    return;
  }

  if (!NEEDS_TARGET.has(cmd)) {
    throw new Error(`Unknown command: ${cmd}`);
  }

  const targetPrefix = args[0];
  if (!targetPrefix) throw new Error('Target ID required. Run "cdp list" first.');

  const cachedPages = loadCachedPages();
  if (!cachedPages) throw new Error('No page list cached. Run "cdp list" first.');
  const targetId = resolvePrefix(
    targetPrefix,
    cachedPages.map((page) => page.targetId),
    'target',
    'Run "cdp list" first.',
  );

  const commandArgs = args.slice(1);
  if (cmd === 'eval') {
    const expression = commandArgs.join(' ');
    if (!expression) throw new Error('Expression required.');
    commandArgs[0] = expression;
  } else if (cmd === 'type') {
    const text = commandArgs.join(' ');
    if (!text) throw new Error('Text required.');
    commandArgs[0] = text;
  } else if (cmd === 'evalraw') {
    if (!commandArgs[0]) throw new Error('CDP method required.');
    if (commandArgs.length > 2) commandArgs[1] = commandArgs.slice(1).join(' ');
  }

  const connection = await connectToDaemon();
  const response = await sendCommand(connection, {
    cmd,
    args: [targetId, ...commandArgs],
  });
  if (!response.ok) throw new Error(response.error);
  if (response.result) console.log(response.result);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
