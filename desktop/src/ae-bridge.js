// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// A client for the After Effects bridge (AE MCP Vision,
// github.com/VolksRat71/after-effects-mcp-vision, docs/INTEGRATIONS.md):
// 127.0.0.1:8791, a bearer token from ~/.ae-mcp-vision/token, and no Origin
// header, because the bridge refuses any web origin. A renderer is a browser
// and would send one, so this only ever runs in the main process; the page
// hears the results over IPC.
//
//   rpc(op, args)     POST /rpc, a host op directly: {ok, result} or {ok, error}
//   tool(name, args)  POST /mcp tools/call, for what the tool layer adds
//                     (ae_masks setPathKeys with keysPath reads the file there)
//   status()          whether the bridge answers, and the AE version
//   listMedia()       the footage in the open project (op `media`)
//
// The token is read on every request (the bridge re-reads it too, so a
// rotated token works at once), and once more after a 401.
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PORT = 8791;
const INSTALL_URL = 'https://github.com/VolksRat71/after-effects-mcp-vision';

/**
 * What went wrong, as a code the page can show a state for:
 *   not-installed  no token file: the extension was never set up
 *   not-running    nothing on the port: AE is closed, or its extension panel is
 *   unauthorized   401 twice: the token does not match
 *   forbidden      403: the bridge refused the request (origin or host)
 *   timeout        no answer in time (AE busy, or a modal dialog open)
 *   outdated       the bridge has no such op: its extension predates this
 *   op-failed      the op ran and failed (its message says why)
 *   bad-response   not the JSON the bridge sends
 */
class AeBridgeError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'AeBridgeError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const MESSAGES = {
  'not-installed': 'The After Effects bridge is not installed (no token at ~/.ae-mcp-vision/token).',
  'not-running': 'After Effects is not answering. Open After Effects, then Window > Extensions > AE MCP Vision.',
  unauthorized: 'After Effects refused the token. Reopen the AE MCP Vision panel to write a fresh one.',
  forbidden: 'After Effects refused the request.',
  timeout: 'After Effects did not answer in time. Close any open dialog in After Effects and try again.',
  outdated: 'The AE MCP Vision extension is too old for this. Update it, then reopen its panel.',
};

function defaultTokenPath() {
  return path.join(os.homedir(), '.ae-mcp-vision', 'token');
}

/**
 * @param {{port?: number, host?: string, tokenPath?: string, timeoutMs?: number}} [opts]
 */
function createAeClient(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? '127.0.0.1';
  const tokenPath = opts.tokenPath ?? defaultTokenPath();
  const defaultTimeout = opts.timeoutMs ?? 15000;
  let mcpId = 0;

  function readToken() {
    let token;
    try {
      token = fs.readFileSync(tokenPath, 'utf8').trim();
    } catch (err) {
      if (err.code === 'ENOENT') throw new AeBridgeError('not-installed', MESSAGES['not-installed']);
      throw new AeBridgeError('not-installed', `Could not read the bridge token (${err.message}).`);
    }
    if (!token) throw new AeBridgeError('not-installed', MESSAGES['not-installed']);
    return token;
  }

  function send(pathname, body, token, timeoutMs) {
    const data = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host, port, path: pathname, method: 'POST',
          // exactly these: no Origin, and the Host the bridge pins
          headers: {
            Host: `${host}:${port}`,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': data.length,
          },
        },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({status: res.statusCode, text: Buffer.concat(chunks).toString('utf8')}));
          res.on('error', reject);
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new AeBridgeError('timeout', MESSAGES.timeout)));
      req.on('error', err => {
        if (err instanceof AeBridgeError) return reject(err);
        if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EHOSTUNREACH') {
          return reject(new AeBridgeError('not-running', MESSAGES['not-running']));
        }
        reject(new AeBridgeError('not-running', `${MESSAGES['not-running']} (${err.message})`));
      });
      req.end(data);
    });
  }

  function parse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function post(pathname, body, {timeoutMs = defaultTimeout} = {}) {
    let res = await send(pathname, body, readToken(), timeoutMs);
    if (res.status === 401) res = await send(pathname, body, readToken(), timeoutMs); // rotated since the read
    if (res.status === 401) throw new AeBridgeError('unauthorized', MESSAGES.unauthorized);
    const json = parse(res.text);
    if (res.status === 403) {
      const why = json?.error?.message ?? json?.error ?? res.text;
      throw new AeBridgeError('forbidden', `${MESSAGES.forbidden} ${typeof why === 'string' ? why : ''}`.trim());
    }
    if (json == null) throw new AeBridgeError('bad-response', `The bridge answered HTTP ${res.status} with no JSON.`);
    return {status: res.status, json};
  }

  /** A host op. Resolves to its result; rejects with an AeBridgeError. */
  async function rpc(op, args = {}, callOpts) {
    const {json} = await post('/rpc', {op, args}, callOpts);
    if (json.ok === true) return json.result;
    const err = json.error ?? {};
    if (err.code === 'unknown_op') throw new AeBridgeError('outdated', MESSAGES.outdated, {op});
    throw new AeBridgeError('op-failed', `After Effects: ${err.message ?? 'the op failed'}`, {op, hostCode: err.code});
  }

  /** An MCP tool, through the tool layer. Resolves to its result (text parsed as JSON when it is JSON). */
  async function tool(name, args = {}, callOpts) {
    const {json} = await post('/mcp', {jsonrpc: '2.0', id: ++mcpId, method: 'tools/call', params: {name, arguments: args}}, callOpts);
    if (json.error != null) throw new AeBridgeError('op-failed', `After Effects: ${json.error.message ?? 'the tool call failed'}`, {tool: name});
    const text = (json.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (json.result?.isError) {
      if (/unknown (command|tool)|no such op/i.test(text)) throw new AeBridgeError('outdated', MESSAGES.outdated, {tool: name});
      throw new AeBridgeError('op-failed', `After Effects: ${text || 'the tool call failed'}`, {tool: name});
    }
    const parsed = parse(text);
    return parsed ?? text;
  }

  /** {state: 'ready', aeVersion} or {state: <error code>, message, installUrl}. Never throws. */
  async function status() {
    try {
      const info = await rpc('hostInfo', {}, {timeoutMs: 5000});
      return {state: 'ready', aeVersion: info?.aeVersion ?? null};
    } catch (err) {
      return describeError(err);
    }
  }

  /** The project's footage: {project, items, ineligible, counts}. */
  function listMedia() {
    return rpc('media', {includeIneligible: true});
  }

  return {rpc, tool, status, listMedia, readToken, port, host};
}

/** An error as the page gets it over IPC: a state code, a message, and the install link. */
function describeError(err) {
  const code = err instanceof AeBridgeError ? err.code : 'op-failed';
  return {state: code, message: err?.message ?? String(err), installUrl: INSTALL_URL};
}

module.exports = {AeBridgeError, createAeClient, describeError, defaultTokenPath, DEFAULT_PORT, INSTALL_URL, MESSAGES};
