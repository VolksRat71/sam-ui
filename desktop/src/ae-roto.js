// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The After Effects round trip, both ways, on top of ae-bridge.js:
//
//   in:  footage listed by the bridge's `media` op is opened IN PLACE (the
//        backend links the file, data/linked.py), never uploaded: an upload
//        is re-encoded to 24 fps and 1280x720, and its frame N would not be
//        AE's frame N. Only unmodified footage qualifies (INTEGRATIONS.md,
//        "the MVP rule"), and the backend refuses a file that decodes to a
//        different size, rate or frame count than AE reports.
//   out: studio's Vector JSON (state/contours.ts) becomes a new comp at the
//        source's own size, rate and duration: the footage once at the bottom
//        as a guide layer, and once per object above it, named after the
//        object, with its outlines as hold mask-path keys (pieces as Add
//        masks, holes as Subtract masks below them). Before anything is
//        written the source is listed again and must still be the same item,
//        file, size, rate and frame count, and the file's bytes must still
//        hash to what they did when it was opened.
//
// Timing: Vector JSON index i is clip frame i + 1, shown from comp time i/fps
// (frame 1 starts at 0). Keys go at i / frameRate with AE's own frameRate,
// not studio's measured one.
//
// The mapping (planExport) is pure: objects in, an ordered list of bridge
// calls out, with {$ref} placeholders for ids the calls return. runPlan
// performs it.
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {AeBridgeError} = require('./ae-bridge');

const VIDEO_EXT = /\.(mp4|mov|m4v)$/i;
const FPS_TOLERANCE = 1e-3;
/**
 * Per call: the bridge caps a body at 5 MB. A host op gets 30 s over /rpc but
 * masks get 3 minutes through the tool layer, so every setPathKeys goes over
 * /mcp (inline, or by keys file when too big for a body), and we wait a little
 * longer than the bridge does so we never give up while AE is still writing.
 */
const INLINE_LIMIT = 4 * 1024 * 1024;
const CHUNK_FRAMES = 600;
const KEYS_TIMEOUT_MS = 200000;
/** More pieces or holes than this in one object is a bad document, not roto. */
const MAX_SLOTS = 256;

const OVERRIDE_NAMES = {
  conformFrameRate: 'a conformed frame rate',
  removePulldown: 'pulldown removal',
  fieldSeparation: 'field separation',
  loop: 'looping',
  useProxy: 'a proxy',
};

/** Why an item from `media` cannot be opened in sam-ui, or null when it can. */
function ineligibleReason(item) {
  if (item.missing) return 'Its file is missing. Reconnect it in After Effects first.';
  if (item.imageSequence) return 'Image sequences are not supported yet.';
  if (item.useProxy) return 'A proxy is in use. Set the proxy to None so sam-ui sees the source frames.';
  const overrides = item.interpretationOverrides ?? [];
  if (overrides.length > 0) {
    const what = overrides.map(o => OVERRIDE_NAMES[o] ?? o).join(', ');
    return `Interpret Footage changes its frames (${what}). Reset it to the file's own settings first.`;
  }
  if (item.pixelAspect != null && Math.abs(item.pixelAspect - 1) > 1e-6) return 'Non-square pixels are not supported yet.';
  if (typeof item.path !== 'string' || !VIDEO_EXT.test(item.path)) return 'sam-ui opens .mp4 and .mov footage.';
  if (!(item.frameRate > 0) || !(item.frames > 0)) return 'It has no frame rate or frames.';
  return null;
}

/** `media`'s reply, each item marked with whether sam-ui can open it (and why not). */
function eligibleMedia(media) {
  return {
    project: media.project,
    items: (media.items ?? []).map(item => {
      const reason = ineligibleReason(item);
      return {...item, eligible: reason == null, ...(reason != null ? {reason} : {})};
    }),
    ineligible: media.ineligible ?? [],
  };
}

/** What sam-ui keeps with a video opened from After Effects. */
function sourceRecord(item, project) {
  return {
    kind: 'afterEffects',
    aeItemId: item.id,
    aeProjectPath: project?.path ?? null,
    name: item.name,
    path: item.path,
    width: item.width,
    height: item.height,
    pixelAspect: item.pixelAspect ?? 1,
    frameRate: item.frameRate,
    frames: item.frames,
    duration: item.duration,
    hasAudio: item.hasAudio === true,
  };
}

/**
 * Everything that differs between the source as it was opened and `media`
 * now (and, with `studio`, the video as studio decoded it). Empty = safe to
 * write. Every entry is a sentence for the user.
 */
function checkSource(source, media, studio) {
  const problems = [];
  const project = media?.project?.path ?? null;
  if (project !== source.aeProjectPath) {
    problems.push(
      `The open After Effects project (${project ?? 'untitled'}) is not the one this video came from (${source.aeProjectPath ?? 'untitled'}).`,
    );
    return problems; // item ids are per project: nothing else can be compared
  }
  const item = (media.items ?? []).find(i => i.id === source.aeItemId);
  if (item == null) {
    problems.push(`"${source.name}" is no longer in the After Effects project (or is no longer footage sam-ui can use).`);
    return problems;
  }
  if (item.path !== source.path) problems.push(`"${item.name}" now points at another file (${item.path}).`);
  if (item.width !== source.width || item.height !== source.height) {
    problems.push(`"${item.name}" is now ${item.width}x${item.height}, not ${source.width}x${source.height}.`);
  }
  if (Math.abs(item.frameRate - source.frameRate) > FPS_TOLERANCE) {
    problems.push(`"${item.name}" now runs at ${round(item.frameRate)} fps, not ${round(source.frameRate)}.`);
  }
  if (item.frames !== source.frames) problems.push(`"${item.name}" now has ${item.frames} frames, not ${source.frames}.`);
  const reason = ineligibleReason(item);
  if (reason != null) problems.push(`"${item.name}": ${reason}`);
  if (studio != null) {
    if (studio.frames != null && studio.frames !== source.frames) {
      problems.push(`sam-ui decoded ${studio.frames} frames, After Effects has ${source.frames}.`);
    }
    if (studio.width != null && (studio.width !== source.width || studio.height !== source.height)) {
      problems.push(`sam-ui decoded ${studio.width}x${studio.height}, After Effects has ${source.width}x${source.height}.`);
    }
  }
  return problems;
}

const round = x => Math.round(x * 1000) / 1000;
const ref = name => ({$ref: name});

/** Keys for one slot: frame i at i / fps, null where the object has no outline. */
function slotKeys(frames, fps) {
  return frames.map((outline, i) => ({time: i / fps, vertices: outline ?? null}));
}

/** Split keys into calls the bridge takes: at most `chunk` frames each. */
function chunks(keys, chunk) {
  const out = [];
  for (let i = 0; i < keys.length; i += chunk) out.push(keys.slice(i, i + chunk));
  return out;
}

const isPoint = p => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/**
 * The slot arrays come from the renderer: each must hold exactly one entry per
 * frame (a short one would leave its last hold key over the rest of the comp,
 * a long one would key past its end), and each entry is null or an outline of
 * at least 3 finite [x, y] points.
 */
function checkSlots(o, label, frames) {
  const slots = [...(o.add ?? []), ...(o.sub ?? [])];
  if (slots.length > MAX_SLOTS) {
    throw new AeBridgeError('mismatch', `${label} has ${slots.length} mask pieces; at most ${MAX_SLOTS} are exported.`);
  }
  for (const frame of slots) {
    if (!Array.isArray(frame) || frame.length !== frames) {
      throw new AeBridgeError('mismatch', `${label} has a mask with ${Array.isArray(frame) ? frame.length : 0} frames; the footage has ${frames}.`);
    }
    for (const outline of frame) {
      if (outline !== null && !(Array.isArray(outline) && outline.length >= 3 && outline.every(isPoint))) {
        throw new AeBridgeError('mismatch', `${label} has an outline that is not a list of at least 3 [x, y] points.`);
      }
    }
  }
}

function baseName(name) {
  return String(name).replace(/\.[^.]+$/, '');
}

/**
 * The bridge calls that build the comp, in order. `objects` are Vector JSON
 * documents (studio's state/contours.ts), each with object.name.
 * Returns {compName, steps}; a step is {op, args, save?, transport, label}.
 */
function planExport({source, objects, inlineLimit = INLINE_LIMIT, chunkFrames = CHUNK_FRAMES}) {
  if (!Array.isArray(objects) || objects.length === 0) throw new AeBridgeError('nothing', 'No object has outlines to export.');
  const fps = source.frameRate;
  for (const o of objects) {
    const label = o.object?.name ?? 'an object';
    if (o.frames !== source.frames || o.w !== source.width || o.h !== source.height) {
      throw new AeBridgeError(
        'mismatch',
        `${label}'s outlines are ${o.w}x${o.h} over ${o.frames} frames; the footage is ${source.width}x${source.height} over ${source.frames}.`,
      );
    }
    checkSlots(o, label, source.frames);
  }
  const title = baseName(source.name);
  const compName = `${title} roto (sam-ui)`;
  const steps = [];
  const step = (label, op, args, extra = {}) => steps.push({label, op, args, transport: 'rpc', ...extra});
  const comp = ref('comp');

  step('create the comp', 'project', {
    command: 'createComp', name: compName, width: source.width, height: source.height,
    pixelAspect: source.pixelAspect ?? 1, frameRate: fps, duration: source.duration,
  }, {save: 'comp'});
  // layers.add puts a layer on top, so the reference goes in first and ends at the bottom
  step('add the source', 'project', {command: 'addToComp', compId: comp, itemId: source.aeItemId}, {save: 'source'});
  step('name the source', 'layers', {command: 'rename', compId: comp, layerId: ref('source'), name: `${title} (source)`});
  step('make the source a guide', 'layers', {command: 'organise', compId: comp, layerId: ref('source'), guideLayer: true});

  // last object first, so the first object ends on top, as in studio's list
  [...objects].reverse().forEach((o, back) => {
    const k = objects.length - 1 - back;
    const name = o.object?.name ?? `object ${k + 1}`;
    const layer = `layer${k}`;
    step(`add ${name}`, 'project', {command: 'addToComp', compId: comp, itemId: source.aeItemId}, {save: layer});
    step(`name ${name}`, 'layers', {command: 'rename', compId: comp, layerId: ref(layer), name});
    if (source.hasAudio) {
      // every copy of the footage carries its audio: keep it on the source only
      step(`mute ${name}`, 'layers', {command: 'setAudioEnabled', compId: comp, layerId: ref(layer), enabled: false});
    }
    const masks = [
      ...(o.add ?? []).map((frames, s) => ({frames, mode: 'add', maskName: `${name} ${s + 1}`})),
      ...(o.sub ?? []).map((frames, s) => ({frames, mode: 'subtract', maskName: `${name} hole ${s + 1}`})),
    ];
    for (const m of masks) {
      // added in this order, holes land below the pieces (masks composite top to bottom)
      step(`mask ${m.maskName}`, 'masks', {command: 'add', compId: comp, layerId: ref(layer), name: m.maskName, mode: m.mode});
      for (const keys of chunks(slotKeys(m.frames, fps), chunkFrames)) {
        const args = {command: 'setPathKeys', compId: comp, layerId: ref(layer), maskName: m.maskName, hold: true, keys};
        const size = Buffer.byteLength(JSON.stringify({op: 'masks', args}));
        step(`keys ${m.maskName} ${keys[0].time.toFixed(3)}s`, 'masks', args, {
          transport: size > inlineLimit ? 'file' : 'tool',
          timeoutMs: KEYS_TIMEOUT_MS,
        });
      }
    }
  });
  return {compName, steps};
}

/** Replace {$ref: name} with the id of the result saved under that name. */
function resolveRefs(args, results) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (v != null && typeof v === 'object' && !Array.isArray(v) && '$ref' in v) {
      const r = results[v.$ref];
      if (r == null || r.id == null) throw new Error(`no id for ${v.$ref}`);
      out[k] = r.id;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Perform a plan. A failure deletes the half-built comp (nothing is left
 * applied without the user hearing it) and rejects with the step that failed.
 */
async function runPlan(plan, client, {tmpDir, onProgress} = {}) {
  const results = {};
  let masks = 0;
  let keys = 0;
  let at = null;
  try {
    for (let n = 0; n < plan.steps.length; n++) {
      const s = plan.steps[n];
      at = s.label;
      const args = resolveRefs(s.args, results);
      let result;
      if (s.transport === 'file') {
        // too big for a /rpc body: the tool layer reads the keys off disk
        if (tmpDir == null) throw new Error('a keys file needs a temp folder');
        const file = path.join(tmpDir, `keys-${n}.json`);
        fs.writeFileSync(file, JSON.stringify(args.keys));
        const {keys: _inline, ...rest} = args;
        result = await client.tool('ae_masks', {...rest, keysPath: file}, {timeoutMs: s.timeoutMs});
      } else if (s.transport === 'tool') {
        result = await client.tool('ae_masks', args, {timeoutMs: s.timeoutMs});
      } else {
        result = await client.rpc(s.op, args, s.timeoutMs != null ? {timeoutMs: s.timeoutMs} : undefined);
      }
      if (s.save) results[s.save] = result;
      if (s.op === 'masks' && s.args.command === 'add') masks++;
      if (s.op === 'masks' && s.args.command === 'setPathKeys') keys += s.args.keys.length;
      if (onProgress) onProgress((n + 1) / plan.steps.length, s.label);
    }
  } catch (err) {
    let tail = '';
    if (results.comp?.id != null) {
      try {
        await client.rpc('project', {command: 'deleteItem', itemId: results.comp.id});
        tail = ' The half-built comp was deleted.';
      } catch {
        tail = ` Delete the comp "${plan.compName}" in After Effects.`;
      }
    }
    throw new AeBridgeError(err.code ?? 'op-failed', `Export to After Effects stopped (${at}): ${err.message}${tail}`, {step: at});
  }
  return {compId: results.comp.id, compName: plan.compName, layers: Object.keys(results).filter(k => k.startsWith('layer')).length, masks, keys};
}

// -- the backend (only the main process can link a file: it has the token) --

/**
 * JSON over http to the local backend: no Origin, which its guard would check.
 * Without `token` it cannot reach /linked (the MCP server's client, mcp-tools.js).
 */
function backendClient({port, token, host = '127.0.0.1'}) {
  function send(method, pathname, body, onResponse, timeoutMs) {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host, port, method, path: pathname,
          headers: {
            Host: `${host}:${port}`,
            ...(data ? {'Content-Type': 'application/json', 'Content-Length': data.length} : {}),
            ...(token ? {'X-Sam-Ui-Link-Token': token} : {}),
          },
        },
        res => onResponse(res, resolve),
      );
      if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('the backend did not answer')));
      req.on('error', reject);
      req.end(data ?? undefined);
    });
  }
  function request(method, pathname, body) {
    return send(method, pathname, body, (res, resolve) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON (an HTML error page)
        }
        resolve({status: res.statusCode, json, text});
      });
    }, 600000);
  }
  return {
    get: pathname => request('GET', pathname),
    /** {status, json, text}: json is null when the reply is not JSON. */
    post: (pathname, body) => request('POST', pathname, body),
    /** GraphQL `data`, or an Error with the backend's messages. */
    async graphql(query, variables) {
      const r = await request('POST', '/graphql', {query, variables});
      const errors = r.json?.errors;
      if (r.status !== 200 || errors?.length || r.json?.data == null) {
        throw new Error(errors?.map(e => e.message).join('; ') || `GraphQL failed (HTTP ${r.status})`);
      }
      return r.json.data;
    },
    /** The response itself, unread and with no timeout: a track stream lasts as long as its clip. */
    stream: (pathname, body) => send('POST', pathname, body, (res, resolve) => resolve(res)),
    /** Link `file` in place with its source record: {path, posterPath, width, height, record}. */
    async link(file, source) {
      const r = await request('POST', '/linked', {path: file, source});
      if (r.status === 200 && r.json) return r.json;
      throw new AeBridgeError(r.status === 422 ? 'mismatch' : 'backend', r.json?.error ?? `The backend refused the file (HTTP ${r.status}).`);
    },
    /**
     * A linked video's record, or null when the video was not opened in place.
     * With verify, `changed` also covers bytes that differ from those hashed at
     * link time (the backend reads the whole file, only when size and mtime match).
     */
    async sourceOf(videoPath, {verify = false} = {}) {
      const r = await request('GET', `/linked-source?path=${encodeURIComponent(videoPath)}${verify ? '&verify=1' : ''}`);
      if (r.status === 404) return null;
      if (r.status === 200 && r.json) return r.json;
      throw new AeBridgeError('backend', `The backend could not read the video's source (HTTP ${r.status}).`);
    },
  };
}

// -- the two flows the page asks for ----------------------------------------

/** Open item `itemId` of the open project in place. Resolves to the backend's video. */
async function openFromAe({client, backend, itemId}) {
  const media = await client.listMedia();
  const item = (media.items ?? []).find(i => i.id === itemId);
  if (item == null) throw new AeBridgeError('mismatch', 'That footage is no longer in the After Effects project. List it again.');
  const reason = ineligibleReason(item);
  if (reason != null) throw new AeBridgeError('ineligible', `"${item.name}": ${reason}`);
  return backend.link(item.path, sourceRecord(item, media.project));
}

/**
 * Export `objects` (Vector JSON) of the video at `videoPath` to a new comp.
 * `studio` is what studio decoded ({frames, width, height}).
 */
async function exportToAe({client, backend, videoPath, objects, studio, tmpDir, onProgress}) {
  // verified: a file swapped in place at the same size and mtime must not get these masks
  const record = await backend.sourceOf(videoPath, {verify: true});
  if (record == null || record.source?.kind !== 'afterEffects') {
    throw new AeBridgeError('not-from-ae', 'This video was not opened from After Effects. Use Open from After Effects in Media first.');
  }
  if (record.missing) throw new AeBridgeError('mismatch', `The footage file is gone (${record.file?.path}).`);
  if (record.changed) {
    throw new AeBridgeError('mismatch', 'The footage file changed on disk since it was opened in sam-ui. Open it from After Effects again.');
  }
  const media = await client.listMedia();
  const problems = checkSource(record.source, media, studio);
  if (problems.length > 0) {
    throw new AeBridgeError('mismatch', `Nothing was written to After Effects. ${problems.join(' ')}`, {problems});
  }
  const plan = planExport({source: record.source, objects});
  return runPlan(plan, client, {tmpDir, onProgress});
}

module.exports = {
  CHUNK_FRAMES,
  INLINE_LIMIT,
  backendClient,
  checkSource,
  eligibleMedia,
  exportToAe,
  ineligibleReason,
  openFromAe,
  planExport,
  resolveRefs,
  runPlan,
  slotKeys,
  sourceRecord,
};
