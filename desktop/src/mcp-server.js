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

/** Ours and nobody else's: owned by this user, no group or other access, not a link. */
function isPrivate(p) {
  const st = fs.lstatSync(p);
  return (st.isFile() || st.isDirectory()) && st.uid === process.getuid() && (st.mode & 0o077) === 0;
}

/** The token, or null when there is none or its file or folder could be someone else's. */
function readToken() {
  try {
    if (!isPrivate(tokenDir()) || !isPrivate(tokenFile())) return null;
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
  if (fs.lstatSync(tokenDir()).uid !== process.getuid() || !fs.lstatSync(tokenDir()).isDirectory()) {
    throw new Error(`${tokenDir()} is not a folder of this user's; the agents' token cannot live there`);
  }
  fs.chmodSync(tokenDir(), 0o700);
  const candidate = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(tokenFile(), candidate, {mode: 0o600, flag: 'wx'});
    return candidate;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const winner = readToken();
    if (winner) return winner;
    // there, but not a token, or open to others, or a link: replace it (rm takes a link, not its target)
    fs.rmSync(tokenFile(), {force: true});
    fs.writeFileSync(tokenFile(), candidate, {mode: 0o600, flag: 'wx'});
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
      return rpcError(null, -32600, 'Not a JSON-RPC 2.0 request');
    }
    const {id, method, params} = msg;
    if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') {
      return rpcError(null, -32600, 'id must be a string, a number or null'); // never echoed: it could be anything
    }
    if (id === undefined) return null; // a notification: never answered, and nothing here acts on one
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
          return rpcResult(id, {});
        case 'tools/list':
          return rpcResult(id, {tools});
        case 'tools/call':
          if (typeof params?.name !== 'string') return rpcError(id, -32602, 'tools/call requires a name');
          return rpcResult(id, await callTool(params.name, params.arguments ?? {}));
        default:
          return rpcError(id, -32601, `Unknown method: ${method}`);
      }
    } catch (err) {
      return rpcError(id, -32603, String(err?.message ?? err));
    }
  }
  return async function handle(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return rpcError(null, -32700, 'Invalid JSON');
    }
    // MCP 2025-06-18 dropped JSON-RPC batches; one call per request also keeps /capture one at a time
    if (Array.isArray(msg)) return rpcError(null, -32600, 'Batches are not supported: send one request per POST');
    return one(msg);
  };
}

// -- HTTP --------------------------------------------------------------------

/**
 * The server over `backend` (a backendClient with no link token). `port` 0
 * lets the OS pick (tests only). listen() rejects when the port is taken.
 * `studio` and `onChange` are the desktop window's view and change hooks
 * (mcp-tools.js); on its own the server has no studio, so sam_studio answers
 * {open: false} and changes go nowhere.
 */
function createMcpServer({backend, port = DEFAULT_PORT, exportRoot, studio = null, onChange, log = () => {}}) {
  const tools = createTools({backend, exportRoot, studio, onChange});
  const rpc = createRpc(tools);
  loadOrCreateToken();

  const server = http.createServer((req, res) => {
    serve(req, res).catch(err => {
      log(`request failed: ${err?.message ?? err}`);
      if (res.headersSent) res.destroy();
      else json(res, 500, {error: 'internal error'});
    });
  });

  async function serve(req, res) {
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
    const expected = readToken(); // read each time, so deleting the file revokes it
    if (expected == null || !sameToken(supplied, expected)) {
      json(res, 401, {error: 'Missing or wrong bearer token. It is in ~/.sam-ui/token; sam-ui\'s Agents menu copies the setup command.'});
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
    if (reply.result?.isError) log(`tool error: ${reply.result.content?.[0]?.text}`);
    json(res, 200, reply);
  }

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
      tools.close(); // held track streams: their jobs are cancelled
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
