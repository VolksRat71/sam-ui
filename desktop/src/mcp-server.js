// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The MCP server (issue #46): agents (Claude Code, Codex, anything that speaks
// MCP) drive sam-ui through the tools in mcp-tools.js. Streamable HTTP, JSON
// replies only, hand-rolled JSON-RPC (as AE MCP Vision: no SDK dependency).
//
//   POST /mcp on 127.0.0.1:8793 only; GET and DELETE answer 405 (no SSE stream,
//   no sessions to end). The port is fixed, never picked: a second server fails
//   loudly instead of moving where no client config points.
//   Auth: a bearer token in ~/.sam-ui/token (64 hex, 0600 in a 0700 folder),
//   created once with an exclusive open and kept across launches, read again on
//   every request (the file is what clients read), compared in constant time.
//   SAM_UI_TOKEN_DIR moves the folder (tests).
//   Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding), and any
//   Origin is refused: nothing in a browser should ever call this.
//
// No require('electron'): main.js starts it in the desktop app, and against a
// dev backend it runs on its own:
//   node desktop/src/mcp-server.js --backend http://127.0.0.1:7263
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {backendClient} = require('./ae-roto');
const {INSTRUCTIONS, createTools} = require('./mcp-tools');

const DEFAULT_PORT = 8793;
const BODY_LIMIT = 1024 * 1024;
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = {name: 'sam-ui', version: require('../package.json').version};

const tokenDir = () => process.env.SAM_UI_TOKEN_DIR || path.join(os.homedir(), '.sam-ui');
const tokenFile = () => path.join(tokenDir(), 'token');
const wellFormed = t => typeof t === 'string' && /^[0-9a-f]{64}$/.test(t);

function readToken() {
  try {
    const t = fs.readFileSync(tokenFile(), 'utf8').trim();
    return wellFormed(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * The token, made on first use. 'wx' fails when another process made it first
 * (the app and a dev server starting together): then both read the winner's.
 */
function loadOrCreateToken() {
  const existing = readToken();
  if (existing) return existing;
  fs.mkdirSync(tokenDir(), {recursive: true, mode: 0o700});
  const candidate = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(tokenFile(), candidate, {mode: 0o600, flag: 'wx'});
    return candidate;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const winner = readToken();
    if (winner) return winner;
    // there, but not a token: replace it
    fs.writeFileSync(tokenFile(), candidate, {mode: 0o600});
    fs.chmodSync(tokenFile(), 0o600);
    return candidate;
  }
}

function sameToken(supplied, expected) {
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)});
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'));
        req.pause(); // unread: the 413 goes out with Connection: close
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// -- JSON-RPC ----------------------------------------------------------------

const rpcResult = (id, result) => ({jsonrpc: '2.0', id, result});
const rpcError = (id, code, message) => ({jsonrpc: '2.0', id, error: {code, message}});

function createRpc({tools, callTool}) {
  async function one(msg) {
    if (msg == null || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg?.id ?? null, -32600, 'Not a JSON-RPC 2.0 request');
    }
    const {id, method, params} = msg;
    const notification = id === undefined; // never answered
    try {
      switch (method) {
        case 'initialize': {
          const asked = params?.protocolVersion;
          return rpcResult(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: {tools: {listChanged: false}},
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          });
        }
        case 'ping':
          return notification ? null : rpcResult(id, {});
        case 'tools/list':
          return rpcResult(id, {tools});
        case 'tools/call':
          if (typeof params?.name !== 'string') return rpcError(id, -32602, 'tools/call requires a name');
          return rpcResult(id, await callTool(params.name, params.arguments ?? {}));
        default:
          return notification ? null : rpcError(id, -32601, `Unknown method: ${method}`);
      }
    } catch (err) {
      return notification ? null : rpcError(id, -32603, String(err?.message ?? err));
    }
  }
  return async function handle(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return rpcError(null, -32700, 'Invalid JSON');
    }
    if (!Array.isArray(msg)) return one(msg);
    const out = (await Promise.all(msg.map(one))).filter(Boolean);
    return out.length ? out : null;
  };
}

// -- HTTP --------------------------------------------------------------------

/**
 * The server over `backend` (a backendClient with no link token). `port` 0
 * lets the OS pick (tests only). listen() rejects when the port is taken.
 */
function createMcpServer({backend, port = DEFAULT_PORT, exportRoot, log = () => {}}) {
  const tools = createTools({backend, exportRoot});
  const rpc = createRpc(tools);
  const token = loadOrCreateToken();

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.origin !== undefined) {
      json(res, 403, {error: 'Requests from a web page are not accepted.'});
      return;
    }
    const live = server.address()?.port ?? port;
    if (![`127.0.0.1:${live}`, `localhost:${live}`].includes(req.headers.host)) {
      json(res, 403, {error: `Unexpected Host: ${req.headers.host}`});
      return;
    }
    const supplied = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
    if (!sameToken(supplied, readToken() ?? token)) {
      json(res, 401, {error: `Missing or wrong bearer token. It is in ${tokenFile()}.`});
      return;
    }
    const url = req.url.split('?')[0];
    if (url !== '/mcp') {
      json(res, 404, {error: `${req.method} ${url}`});
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, {Allow: 'POST', 'Content-Length': 0});
      res.end();
      return;
    }
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      res.setHeader('Connection', 'close');
      json(res, 413, {error: err.message});
      return;
    }
    const reply = await rpc(raw);
    if (reply === null) {
      res.writeHead(202, {'Content-Length': 0});
      res.end();
      return;
    }
    if (!Array.isArray(reply) && reply.result?.isError) log(`tool error: ${reply.result.content?.[0]?.text}`);
    json(res, 200, reply);
  });

  return {
    server,
    tools,
    tokenFile: tokenFile(),
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port)); // loopback only
      });
    },
    close() {
      return new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

/** The `claude mcp add` line for this server. */
function claudeAddCommand(port = DEFAULT_PORT) {
  return `claude mcp add --transport http --scope user sam-ui http://127.0.0.1:${port}/mcp --header "Authorization: Bearer $(cat ${tokenFile()})"`;
}

module.exports = {DEFAULT_PORT, claudeAddCommand, createMcpServer, loadOrCreateToken, tokenFile};

if (require.main === module) {
  const arg = name => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const url = new URL(arg('--backend') ?? 'http://127.0.0.1:7263');
  const app = createMcpServer({
    backend: backendClient({host: url.hostname, port: Number(url.port || 80)}),
    port: Number(arg('--port') ?? DEFAULT_PORT),
    log: m => console.error(m),
  });
  app.listen().then(
    port => console.error(`sam-ui MCP on http://127.0.0.1:${port}/mcp over ${url.origin}; token in ${app.tokenFile}\n${claudeAddCommand(port)}`),
    err => {
      console.error(`sam-ui MCP could not start: ${err.message}`);
      process.exit(1);
    },
  );
}
