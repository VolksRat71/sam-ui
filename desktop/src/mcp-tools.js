// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The MCP tools (issue #46): a thin layer over the backend's own endpoints
// (docs/development.md, "API, in brief"), one tool per noun with a `command`,
// as AE MCP Vision does. Videos, objects and jobs are named by id, never by
// path: a video is its `videos` path (gallery/01_dog.mp4), which the backend
// checks itself (session_video_path), and an export is a folder name joined
// here under ~/Movies/sam-ui. Replies leave out urls and the server's paths.
//
// The backend client never carries the link token (ae-roto.js backendClient
// without `token`), so nothing here can open a file in place (/linked).
//
// Track jobs: /track_objects only runs while someone reads its stream, and a
// dropped reader cancels the job. So `sam_track start` opens the stream here,
// answers once the job's headers arrive and keeps reading: only the text after
// the last part boundary is kept, for the closing {"done": ...} part. A
// finished job's result is held 30 minutes for `status` and `wait`.
//
// Studio awareness (issue #73), in the desktop app only: `studio.view()` is
// what the person sees (parseView, reported by studio over IPC), and every
// change an agent makes is told to `onChange` once the backend has taken it,
// keyed by video, so studio shows it live. On the video studio has open,
// sam_session open shares studio's session instead of starting another.
'use strict';

const os = require('node:os');
const path = require('node:path');

const EXPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HELD_MS = 30 * 60 * 1000;
const WAIT_MAX_S = 50;
const BOUNDARY = '--frame';
// studio/src/state/engines.ts BROWSER_ENGINE: runs in the page, unknown to the backend
const BROWSER_ENGINE = 'browser-sam2';
const SHARED_GONE = 'The person closed this video in studio. sam_session open it again.';

const INSTRUCTIONS =
  'Drives sam-ui: SAM 2 / SAM 3 masks and tracks for video objects. The workflow: ' +
  'sam_query {command:"videos"} to pick a video_id; sam_session {command:"open"} for a session_id and a first look at frame 0; ' +
  'sam_edit {command:"points"} (or "text" with SAM 3) to seed an object on a frame, answered with a picture of that frame; ' +
  'sam_capture to look at other frames; sam_track {command:"start"} then {command:"wait"} until it is done; ' +
  'sam_review {command:"queue"} for the frames most worth checking, sam_capture them, fix with sam_edit and track again; ' +
  'then sam_export to a folder name. Always LOOK at a capture after an edit or a track instead of trusting the numbers: ' +
  'a mask can sit on the wrong object. Points are normalised 0-1 (x right, y down), frames start at 0. ' +
  'Object ids are yours to pick: a new id makes a new object (sam_query objects gives next_id). ' +
  'When you are helping a person in the sam-ui app, call sam_studio {command:"state"} first: the frame and layer they are on ' +
  'are what "this" means, and your edits on their video show in studio as you make them.';

const objectFields = 'objectId state engine frames nFrames seeds { frameIndex points labels text } ' +
  'tracks { engine state frames } ranges { start end state source score } history { canUndo canRedo }';

/** An ObjectTrack as the agent sees it: clicks summarised, no masks. */
function objectSummary(o, names = {}) {
  return {
    object_id: o.objectId,
    name: names[String(o.objectId)] ?? null,
    state: o.state,
    engine: o.engine,
    frames: o.frames,
    seeds: (o.seeds ?? []).map(s => ({
      frame: s.frameIndex,
      points: s.points.map((p, i) => [round4(p[0]), round4(p[1]), s.labels[i]]),
      ...(s.text ? {text: s.text} : {}),
    })),
    ranges: o.ranges,
    tracks: (o.tracks ?? []).map(t => ({engine: t.engine, state: t.state, frames: t.frames})),
    can_undo: o.history?.canUndo ?? false,
    can_redo: o.history?.canRedo ?? false,
  };
}

const round4 = x => Math.round(x * 1e4) / 1e4;
const nextId = objects => objects.reduce((m, o) => Math.max(m, o.object_id), -1) + 1;

class ToolError extends Error {}

// -- argument checks: everything an agent sends is checked before the backend sees it

function need(args, key, check, what) {
  const v = args[key];
  if (!check(v)) throw new ToolError(`${key} must be ${what}`);
  return v;
}
const isInt = v => Number.isInteger(v);
const isNat = v => Number.isInteger(v) && v >= 0;
const isStr = v => typeof v === 'string' && v.length > 0 && v.length <= 512;
const opt = (args, key, check, what) => (args[key] == null ? undefined : need(args, key, check, what));
const sessionId = args => need(args, 'session_id', isStr, 'the session_id from sam_session open');
const objectIds = args => opt(args, 'object_ids', v => Array.isArray(v) && v.every(isNat), 'a list of object ids');
const engine = args => opt(args, 'engine', v => typeof v === 'string' && /^[a-z0-9_-]{1,32}$/.test(v), 'an engine name (sam_query engines)');
const isPoint = p => Array.isArray(p) && p.length === 3 && [0, 1].every(i => Number.isFinite(p[i]) && p[i] >= 0 && p[i] <= 1) &&
  (p[2] === 0 || p[2] === 1);

// -- the person's view, as studio reports it over IPC (a trust boundary: checked whole or dropped)

const VIEW_LIMIT = 64 * 1024;
const LIST_LIMIT = 1000;
const isSafeNat = v => Number.isSafeInteger(v) && v >= 0;
const isPlain = v => v != null && typeof v === 'object' && !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));

/**
 * Studio's view report, as {open: false}, or {open: true, video_id, session_id,
 * frame, n_frames, playing, active_object, engine, hidden_objects, colors,
 * next_object_id}, or null when anything in it is off: only the known keys
 * are copied, and nothing is half-taken.
 */
function parseView(v) {
  if (!isPlain(v)) return null;
  try {
    if (JSON.stringify(v).length > VIEW_LIMIT) return null;
  } catch {
    return null; // a cycle, a BigInt
  }
  if (v.open === false) return {open: false};
  if (v.open !== true) return null;
  const {video_id, session_id, frame, n_frames, playing, active_object, engine: e, hidden_objects, colors, next_object_id} = v;
  const ok =
    typeof video_id === 'string' && video_id.length >= 1 && video_id.length <= 512 && !/[\x00-\x1f\x7f]/.test(video_id) &&
    typeof session_id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(session_id) &&
    isSafeNat(frame) && isSafeNat(n_frames) && frame < n_frames && isSafeNat(next_object_id) &&
    typeof playing === 'boolean' && (active_object === null || isSafeNat(active_object)) &&
    typeof e === 'string' && /^[a-z0-9_-]{1,32}$/.test(e) &&
    Array.isArray(hidden_objects) && hidden_objects.length <= LIST_LIMIT && hidden_objects.every(isSafeNat) &&
    isPlain(colors) && Object.keys(colors).length <= LIST_LIMIT &&
    Object.entries(colors).every(([id, c]) => /^\d{1,9}$/.test(id) && typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c));
  if (!ok) return null;
  return {open: true, video_id, session_id, frame, n_frames, playing, active_object, engine: e,
    hidden_objects: [...hidden_objects], colors: Object.fromEntries(Object.entries(colors)), next_object_id};
}

// -- MCP content

const text = value => ({content: [{type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1)}]});
const failure = message => ({content: [{type: 'text', text: message}], isError: true});
/** A capture reply as an image the agent sees, then its legend, then `extra`. */
function pictured(cap, extra) {
  const content = [{type: 'image', data: cap.image, mimeType: cap.mime_type}];
  content.push({type: 'text', text: JSON.stringify({...(extra ?? {}), capture: {width: cap.width, height: cap.height, ...cap.legend}}, null, 1)});
  return {content};
}

const TOOLS = [
  {
    name: 'sam_query',
    description:
      'Read what sam-ui has. START HERE with videos.\n' +
      '- videos: every video, as {video_id, width, height}. Pass video_id to sam_session open.\n' +
      '- engines: the tracking engines (sam2, sam3), whether each can run here and why not, and which read text prompts.\n' +
      '- objects (session_id): every object on the session\'s video: track state per engine, seed frames and their clicks, ' +
      'ranges, can_undo/can_redo, name, and next_id (the id for a new object).\n' +
      'Costs a few hundred tokens; objects grows with the clicks.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {type: 'string', enum: ['videos', 'engines', 'objects']},
        session_id: {type: 'string'},
      },
      required: ['command'],
    },
  },
  {
    name: 'sam_session',
    description:
      'Open or close a session on a video. A session holds SAM 2\'s state for clicks; objects, clicks and tracks are kept ' +
      'on disk per video, so a new session on the same video sees them again.\n' +
      '- open (video_id): {session_id, n_frames, fps, objects, next_id} and a picture of frame 0 with any masks (about 450 tokens). ' +
      'On the video the person has open in studio it shares studio\'s session (shared: true) and pictures their frame (studio_frame): ' +
      'your edits show in studio as you make them, and the person\'s undo can step one back.\n' +
      '- close (session_id): frees the session. Idle sessions close themselves after 30 minutes. A shared session stays open ' +
      '(closed: false): it is the person\'s.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {type: 'string', enum: ['open', 'close']},
        video_id: {type: 'string', description: 'open: from sam_query videos, e.g. gallery/01_dog.mp4'},
        session_id: {type: 'string'},
      },
      required: ['command'],
    },
  },
  {
    name: 'sam_edit',
    description:
      'Change an object\'s seeds. points and text answer with a picture of the frame with the masks (about 450 tokens; ' +
      'capture:false to skip it). LOOK at it: the mask must cover the object you meant and nothing else.\n' +
      '- points (session_id, object_id, frame, points): set the object\'s clicks on that frame, replacing its earlier clicks there. ' +
      'points are [[x, y, label]], x and y normalised 0-1, label 1 = on the object, 0 = not on it. One positive click on the middle ' +
      'of the object usually does; add a 0 on whatever got wrongly included. A new object_id makes a new object.\n' +
      '- text (session_id, object_id, frame, text): seed the frame from a phrase (needs SAM 3; see sam_query engines). ' +
      'Answers matched, score, instances and box.\n' +
      '- range (session_id, object_id, start, end, state): mark frames start-end "absent" (not in the shot: never tracked, ' +
      'exported empty), "present", or "clear" to drop marks.\n' +
      '- undo / redo (session_id, object_id): the object\'s last seed change (a click set, a text seed, an absent range).\n' +
      '- remove (session_id, object_id): delete the object and its tracks.\n' +
      'Edits make the object\'s track stale: run sam_track start again afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {type: 'string', enum: ['points', 'text', 'range', 'undo', 'redo', 'remove']},
        session_id: {type: 'string'},
        object_id: {type: 'integer', minimum: 0},
        frame: {type: 'integer', minimum: 0},
        points: {type: 'array', items: {type: 'array', items: {type: 'number'}, minItems: 3, maxItems: 3}},
        text: {type: 'string'},
        start: {type: 'integer', minimum: 0},
        end: {type: 'integer', minimum: 0},
        state: {type: 'string', enum: ['absent', 'present', 'clear']},
        engine: {type: 'string', description: 'points/text: the engine to segment with (default sam2; text needs sam3).'},
        capture: {type: 'boolean', description: 'points/text: answer with a picture (default true).'},
      },
      required: ['command', 'session_id', 'object_id'],
    },
  },
  {
    name: 'sam_track',
    description:
      'Track objects through the whole clip from their seeds. Runs in the background; a long clip takes minutes.\n' +
      '- start (session_id, object_ids?, engine?): tracks the given objects, or every untracked or stale one. ' +
      'Answers {job_id, objects, bounded}. objects is empty when nothing needed tracking.\n' +
      '- wait (session_id, job_id, timeout_s? <= 50, default 30): blocks until the job ends or the time is up; call it again ' +
      'while state is "running". Answers {state: running | done | failed | canceled, frames_done, n_frames, tracked, failed}.\n' +
      '- status (session_id, job_id?): the same without waiting; without job_id, every job on the video.\n' +
      '- cancel (session_id, job_id).\n' +
      'After a track, check it: sam_review queue, then sam_capture the frames it names.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {type: 'string', enum: ['start', 'wait', 'status', 'cancel']},
        session_id: {type: 'string'},
        job_id: {type: 'string'},
        object_ids: {type: 'array', items: {type: 'integer', minimum: 0}},
        engine: {type: 'string'},
        timeout_s: {type: 'number', minimum: 0, maximum: WAIT_MAX_S},
      },
      required: ['command', 'session_id'],
    },
  },
  {
    name: 'sam_review',
    description:
      'The review queue: where tracked masks most likely went wrong (jumps, area changes, flicker, edges, engine disagreement), best first.\n' +
      '- queue (session_id, object_ids?, engine?, limit? default 10): the top locations, each {object_id, frame, start, end, score, reasons, reviewed}. ' +
      'sam_capture a location\'s frame (or a sheet of start-end) to see it.\n' +
      '- mark (session_id, object_id, frame, reviewed? default true, span? [first, last]): mark a location as looked at and right, ' +
      'so it drops down the queue. reviewed:false removes the mark.\n' +
      'Fixing what a capture shows: a mask on the wrong thing takes sam_edit points on that frame (a 0 on the wrong part, ' +
      'a 1 on the object); an object that left the shot (reasons "stop" or "area", a sliver at the edge) takes sam_edit range ' +
      'absent over the frames it is gone. Then sam_track start again: only the changed stretch re-tracks.\n' +
      'A few hundred tokens per 10 locations.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {type: 'string', enum: ['queue', 'mark']},
        session_id: {type: 'string'},
        object_ids: {type: 'array', items: {type: 'integer', minimum: 0}},
        object_id: {type: 'integer', minimum: 0},
        frame: {type: 'integer', minimum: 0},
        engine: {type: 'string'},
        limit: {type: 'integer', minimum: 1, maximum: 50},
        reviewed: {type: 'boolean'},
        span: {type: 'array', items: {type: 'integer', minimum: 0}, minItems: 2, maxItems: 2},
      },
      required: ['command', 'session_id'],
    },
  },
  {
    name: 'sam_capture',
    description:
      'LOOK at frames with the masks drawn on, as studio shows them: each object in its colour (40% fill, outline, its id at its ' +
      'box\'s top left), clicks as + (positive) and x (negative). Objects marked absent on a frame are not drawn. The legend gives ' +
      'per object its name, colour and track state, and per frame drawn what was drawn (on_frame: seed, track, absent, none), its ' +
      'area in % of the frame and its box (x0, y0, x1, y1, normalised 0-1).\n' +
      '- frame (session_id, frame, long_edge? default 768, max 1280): one frame. About 450 tokens at 768x432. ' +
      'On studio\'s session frame defaults to the frame the person is on.\n' +
      '- sheet (session_id, frames [up to 12] or start + end + count): a contact sheet of labelled cells ' +
      '(long_edge per cell, default 320, max 480; the sheet is at most 1568 px). About 1,500 tokens for 6 frames.\n' +
      'object_ids limits which objects are drawn; engine picks whose tracks (default sam2). On studio\'s session the ' +
      'defaults are what the person sees: their colours and engine, and their hidden layers left out (legend hidden).',
    inputSchema: {
      type: 'object',
      properties: {
        command: {type: 'string', enum: ['frame', 'sheet']},
        session_id: {type: 'string'},
        frame: {type: 'integer', minimum: 0},
        frames: {type: 'array', items: {type: 'integer', minimum: 0}, minItems: 1, maxItems: 12},
        start: {type: 'integer', minimum: 0},
        end: {type: 'integer', minimum: 0},
        count: {type: 'integer', minimum: 1, maximum: 12},
        object_ids: {type: 'array', items: {type: 'integer', minimum: 0}},
        engine: {type: 'string'},
        long_edge: {type: 'integer', minimum: 64},
      },
      required: ['command', 'session_id'],
    },
  },
  {
    name: 'sam_export',
    description:
      'Export tracked objects as a rotoscoping working folder (products.json, per-object PNG mattes, the review notes) ' +
      'to ~/Movies/sam-ui/<name>. name is a folder name only: letters, digits, ".", "_" and "-", up to 64, no paths. ' +
      'An existing folder that already holds mattes or decisions is refused rather than overwritten: pick a new name. ' +
      'Only tracked objects are exported; stale or untracked ones are listed under skipped (track them first). ' +
      'object_ids limits the objects; union also writes a union matte per group.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {type: 'string'},
        name: {type: 'string', pattern: EXPORT_NAME.source},
        object_ids: {type: 'array', items: {type: 'integer', minimum: 0}},
        engine: {type: 'string'},
        union: {type: 'boolean'},
      },
      required: ['session_id', 'name'],
    },
  },
  {
    name: 'sam_studio',
    description:
      'What the person sees in the sam-ui app. Call state FIRST when you are helping a person: their frame is what "this ' +
      'frame" means, and their selected layer is the one they are working on, so leave it alone unless they ask.\n' +
      '- state: {open: false} when studio has no video open (or this is not the app), else {open: true, video_id, ' +
      'session_id, frame, n_frames, playing, active_object: {id, name} | null, engine, hidden_objects, colors, next_object_id}. ' +
      'sam_session open on that video_id shares that session. About 150 tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {type: 'string', enum: ['state']},
      },
      required: ['command'],
    },
  },
];

/**
 * The tool table over `backend` (ae-roto.js backendClient, without a token).
 * `exportRoot` is where sam_export writes (~/Movies/sam-ui); `now` is for tests.
 * `studio` ({view(): a parseView result or null}) is the desktop app's window,
 * null on its own; `onChange` hears each change an agent made (see change()).
 */
function createTools({backend, exportRoot = path.join(os.homedir(), 'Movies', 'sam-ui'), now = Date.now,
  studio = null, onChange = () => {}} = {}) {
  /** job_id -> {sessionId, videoId, objects, result: null until the stream ends, endedAt, done: Promise} */
  const held = new Map();
  /** session_id -> video_id, for the sessions opened here (studio's comes from its view) */
  const opened = new Map();
  /** studio's session ids handed out by open: never closed here */
  const shared = new Set();

  /** Studio's view while it has a video open, else null. */
  function view() {
    const v = studio?.view() ?? null;
    return v?.open === true ? v : null;
  }
  /** The view when studio is on this session, else null. */
  const studioOn = sid => (view()?.session_id === sid ? view() : null);
  const videoOf = sid => studioOn(sid)?.video_id ?? opened.get(sid) ?? null;
  /** next_id: past studio's own next id too (a new layer it holds that has no clicks yet) when studio is on that video. */
  function nextIdFor(sid, list) {
    const v = view();
    const vid = videoOf(sid);
    return Math.max(nextId(list), v != null && vid != null && v.video_id === vid ? v.next_object_id : 0);
  }

  /**
   * Tell studio an agent changed `sid`'s video: {video_id, kind, object_ids,
   * frame?, end?, state?, job_id?, name?, at}. Only after the backend took the
   * change, and only for a session whose video is known here.
   */
  function change(sid, kind, objectIdList, extra = {}) {
    const video_id = extra.video_id ?? videoOf(sid);
    if (video_id == null) return;
    try {
      onChange({...extra, video_id, kind, object_ids: objectIdList, at: now()});
    } catch {
      // a closed window: the change itself went through
    }
  }

  /** /capture's body on studio's session: the person's colours (args never set colours). */
  const look = (sid, body) => {
    const v = studioOn(sid);
    return v != null && Object.keys(v.colors).length > 0 ? {...body, colors: v.colors} : body;
  };

  /** Drop results older than 30 minutes, and streams silent that long (destroyed: the backend cancels their jobs). */
  function sweep() {
    for (const [id, job] of held) {
      if (now() - (job.result != null ? job.endedAt : job.lastAt) > HELD_MS) {
        job.res.destroy();
        held.delete(id);
      }
    }
  }

  async function post(pathname, body) {
    const r = await backend.post(pathname, body);
    if (r.status !== 200 || r.json == null) {
      throw new ToolError(r.json?.error ?? `The backend answered HTTP ${r.status} to ${pathname}: ${String(r.text).slice(0, 300)}`);
    }
    return r.json;
  }

  async function names(sid) {
    return (await post('/object_names', {session_id: sid})).names ?? {};
  }

  async function objects(sid) {
    const [data, n] = await Promise.all([
      backend.graphql(`query($s: String!) { objectTracks(sessionId: $s) { ${objectFields} } }`, {s: sid}),
      names(sid),
    ]);
    return data.objectTracks.map(o => objectSummary(o, n));
  }

  async function objectChange(mutation, input, sid) {
    const data = await backend.graphql(`mutation($i: ${mutation.input}!) { ${mutation.name}(input: $i) { ${objectFields} } }`, {i: input});
    return objectSummary(data[mutation.name], await names(sid));
  }

  // -- track jobs ---------------------------------------------------------

  async function startTrack(args) {
    sweep();
    const sid = sessionId(args);
    const body = {session_id: sid};
    const ids = objectIds(args);
    if (ids) body.object_ids = ids;
    const e = engine(args);
    if (e) body.engine = e;
    const res = await backend.stream('/track_objects', body);
    if (res.statusCode !== 200) {
      const chunks = [];
      for await (const c of res) chunks.push(c);
      const t = Buffer.concat(chunks).toString('utf8');
      let msg = t.slice(0, 300);
      try {
        msg = JSON.parse(t).error ?? msg;
      } catch {
        // an HTML error page
      }
      throw new ToolError(`Tracking was refused: ${msg}`);
    }
    const jobId = res.headers['job-id'];
    if (!jobId) {
      res.destroy(); // a job nothing holds would outlive close() and sweep()
      throw new ToolError('Tracking started without a job id; nothing to follow.');
    }
    const objs = String(res.headers['objects-tracked'] ?? '').split(',').filter(Boolean).map(Number);
    const bounded = String(res.headers['objects-bounded'] ?? '').split(',').filter(Boolean).map(Number);
    const job = {sessionId: sid, objects: objs, result: null, endedAt: null, lastAt: now(), res};
    const videoId = videoOf(sid); // the job's video, though studio may move off it before the end
    if (objs.length > 0) change(sid, 'track_start', objs, {job_id: jobId});
    job.done = new Promise(resolve => {
      let tail = '';
      res.setEncoding('latin1'); // bytes as they are; only the last part is decoded
      res.on('data', chunk => {
        job.lastAt = now();
        tail += chunk;
        const at = tail.lastIndexOf(BOUNDARY);
        if (at > 0) tail = tail.slice(at);
      });
      const finish = result => {
        if (job.result != null) return;
        job.result = result;
        job.endedAt = now();
        resolve();
        // a cancel was told as it was asked for (sam_track cancel, or studio's own)
        if (objs.length > 0 && result.error !== 'canceled') {
          change(sid, 'track_done', result.done ? (result.tracked ?? objs) : objs, {video_id: videoId, job_id: jobId, state: result.done ? 'done' : 'failed'});
        }
      };
      res.on('end', () => finish(closingPart(tail)));
      res.on('error', err => finish({done: false, error: `the stream broke: ${err.message}`}));
      res.on('close', () => finish({done: false, error: 'the stream closed early'}));
    });
    held.set(jobId, job);
    return {job_id: jobId, objects: objs, bounded};
  }

  async function jobStatus(sid, jobId) {
    sweep();
    const running = (await post('/track_jobs', {session_id: sid})).jobs ?? [];
    const describe = id => {
      const job = held.get(id);
      const live = running.find(j => j.job_id === id);
      if (job?.result != null) {
        const r = job.result;
        const state = r.done ? 'done' : r.error === 'canceled' ? 'canceled' : 'failed';
        return {job_id: id, state, objects: r.objects ?? job.objects, tracked: r.tracked ?? [], failed: r.failed ?? {},
          ...(r.error ? {error: r.error} : {})};
      }
      if (live) return {job_id: id, state: 'running', objects: live.objects, frames_done: live.frames_done, n_frames: live.n_frames, elapsed_s: live.elapsed_s};
      if (job) return {job_id: id, state: 'running', objects: job.objects}; // started, not listed yet
      return null;
    };
    if (jobId != null) {
      const got = describe(jobId);
      if (got == null) throw new ToolError(`No job ${jobId} on this video (finished jobs are kept 30 minutes).`);
      return got;
    }
    const ids = new Set([...running.map(j => j.job_id), ...[...held].filter(([, j]) => j.sessionId === sid).map(([id]) => id)]);
    return {jobs: [...ids].map(describe)};
  }

  async function waitTrack(args) {
    const sid = sessionId(args);
    const jobId = need(args, 'job_id', isStr, 'the job_id from sam_track start');
    const timeout = Math.min(WAIT_MAX_S, opt(args, 'timeout_s', v => Number.isFinite(v) && v >= 0, 'seconds, at most 50') ?? 30);
    const job = held.get(jobId);
    if (job && job.result == null) {
      let timer;
      await Promise.race([job.done, new Promise(r => (timer = setTimeout(r, timeout * 1000)))]);
      clearTimeout(timer);
    }
    return jobStatus(sid, jobId);
  }

  async function history(name, args) {
    const sid = sessionId(args);
    const obj = need(args, 'object_id', isNat, 'an object id');
    const out = await objectChange({name, input: 'SeedHistoryInput'}, {sessionId: sid, objectId: obj}, sid);
    change(sid, name === 'undoSeeds' ? 'undo' : 'redo', [obj]);
    return text(out);
  }

  // -- the commands -------------------------------------------------------

  const commands = {
    sam_query: {
      async videos() {
        const data = await backend.graphql('{ videos { edges { node { path width height } } } }');
        return text(data.videos.edges.map(({node}) => ({video_id: node.path, width: node.width, height: node.height})));
      },
      async engines() {
        const r = await backend.get('/engines');
        if (r.status !== 200 || !r.json) throw new ToolError(`The backend answered HTTP ${r.status} to /engines`);
        return text(r.json.engines.map(e => ({
          name: e.name, default: e.default, available: e.available, reason: e.reason, text: e.text, text_reason: e.text_reason,
        })));
      },
      async objects(args) {
        const sid = sessionId(args);
        const list = await objects(sid);
        return text({objects: list, next_id: nextIdFor(sid, list)});
      },
    },
    sam_session: {
      async open(args) {
        const videoId = need(args, 'video_id', isStr, 'a video_id from sam_query videos');
        const v = view();
        if (v?.video_id === videoId) {
          // studio has it open: one decoded copy and one click state, the person's (#73)
          const sid = v.session_id;
          shared.add(sid);
          const list = await objects(sid);
          const cap = await post('/capture', look(sid, {session_id: sid, frames: [v.frame]}));
          return pictured(cap, {session_id: sid, video_id: videoId, shared: true, studio_frame: v.frame,
            n_frames: cap.legend.n_frames, fps: cap.legend.fps, objects: list, next_id: nextIdFor(sid, list),
            note: 'This is the session the person has open in studio: your edits show there as you make them, and their ' +
              'undo can step one back. Ask before changing the layer they have selected (sam_studio state).'});
        }
        const data = await backend.graphql(`mutation($i: StartSessionInput!) { startSession(input: $i) { sessionId objects { ${objectFields} } } }`,
          {i: {path: videoId}});
        const sid = data.startSession.sessionId;
        opened.set(sid, videoId);
        const n = await names(sid);
        const list = data.startSession.objects.map(o => objectSummary(o, n));
        const cap = await post('/capture', {session_id: sid, frames: [0]});
        return pictured(cap, {session_id: sid, video_id: videoId, shared: false, n_frames: cap.legend.n_frames, fps: cap.legend.fps,
          objects: list, next_id: nextIdFor(sid, list)});
      },
      async close(args) {
        const sid = sessionId(args);
        if (shared.has(sid) || studioOn(sid) != null) return text({closed: false, shared: true});
        const data = await backend.graphql('mutation($i: CloseSessionInput!) { closeSession(input: $i) { success } }',
          {i: {sessionId: sid}});
        opened.delete(sid);
        return text({closed: data.closeSession.success});
      },
    },
    sam_edit: {
      async points(args) {
        const sid = sessionId(args);
        const obj = need(args, 'object_id', isNat, 'an object id (a whole number, 0 or more)');
        const frame = need(args, 'frame', isNat, 'a frame number (from 0)');
        const points = need(args, 'points', v => Array.isArray(v) && v.length >= 1 && v.length <= 64 && v.every(isPoint),
          '1 to 64 [x, y, label] with x and y from 0 to 1 and label 1 (on the object) or 0 (not on it)');
        const e = engine(args);
        await backend.graphql('mutation($i: AddPointsInput!) { addPoints(input: $i) { frameIndex } }', {i: {
          sessionId: sid, frameIndex: frame, objectId: obj, clearOldPoints: true,
          points: points.map(p => [p[0], p[1]]), labels: points.map(p => p[2]), ...(e ? {engine: e} : {}),
        }});
        change(sid, 'points', [obj], {frame});
        const done = {object_id: obj, frame, clicks: points.length};
        if (args.capture === false) return text(done);
        return pictured(await post('/capture', look(sid, {session_id: sid, frames: [frame], ...(e ? {engine: e} : {})})), done);
      },
      async text(args) {
        const sid = sessionId(args);
        const obj = need(args, 'object_id', isNat, 'an object id');
        const frame = need(args, 'frame', isNat, 'a frame number (from 0)');
        const phrase = need(args, 'text', v => typeof v === 'string' && v.trim().length > 0 && v.length <= 200, 'a short phrase');
        const e = engine(args);
        const r = await post('/text_prompt', {session_id: sid, object_id: obj, frame_index: frame, text: phrase, ...(e ? {engine: e} : {})});
        const {mask: _mask, ...out} = r;
        if (r.matched) change(sid, 'text', [obj], {frame});
        if (args.capture === false || !r.matched) return text(out);
        return pictured(await post('/capture', look(sid, {session_id: sid, frames: [frame]})), out);
      },
      async range(args) {
        const sid = sessionId(args);
        const obj = need(args, 'object_id', isNat, 'an object id');
        const start = need(args, 'start', isNat, 'a frame number');
        const end = need(args, 'end', v => isNat(v) && v >= start, 'a frame number, start or later');
        const state = need(args, 'state', v => ['absent', 'present', 'clear'].includes(v), '"absent", "present" or "clear"');
        const out = await objectChange({name: 'setObjectRange', input: 'SetObjectRangeInput'},
          {sessionId: sid, objectId: obj, start, end, state: state === 'clear' ? null : state}, sid);
        change(sid, 'range', [obj], {frame: start, end, state});
        return text(out);
      },
      undo: args => history('undoSeeds', args),
      redo: args => history('redoSeeds', args),
      async remove(args) {
        const sid = sessionId(args);
        const obj = need(args, 'object_id', isNat, 'an object id');
        await backend.graphql('mutation($i: RemoveObjectInput!) { removeObject(input: $i) { frameIndex } }',
          {i: {sessionId: sid, objectId: obj}});
        change(sid, 'remove', [obj]);
        return text({removed: obj});
      },
    },
    sam_track: {
      start: async args => text(await startTrack(args)),
      wait: async args => text(await waitTrack(args)),
      status: async args => text(await jobStatus(sessionId(args), opt(args, 'job_id', isStr, 'a job_id'))),
      async cancel(args) {
        const sid = sessionId(args);
        const jobId = need(args, 'job_id', isStr, 'a job_id');
        const r = await post('/cancel_track', {session_id: sid, job_id: jobId});
        if (r.canceled) change(sid, 'track_cancel', held.get(jobId)?.objects ?? [], {job_id: jobId});
        return text({canceled: r.canceled});
      },
    },
    sam_review: {
      async queue(args) {
        const limit = opt(args, 'limit', v => isInt(v) && v >= 1 && v <= 50, '1 to 50') ?? 10;
        const ids = objectIds(args);
        const e = engine(args);
        const r = await post('/review_queue', {session_id: sessionId(args), ...(ids ? {object_ids: ids} : {}), ...(e ? {engine: e} : {})});
        const objs = Object.fromEntries(Object.entries(r.objects ?? {}).map(([id, o]) => [id, {state: o.state, n_frames: o.n_frames, locations: (o.locations ?? []).length}]));
        return text({engine: r.engine, compare: r.compare, total: (r.queue ?? []).length, queue: (r.queue ?? []).slice(0, limit), objects: objs});
      },
      async mark(args) {
        const span = opt(args, 'span', v => Array.isArray(v) && v.length === 2 && v.every(isNat) && v[0] <= v[1], '[first, last]');
        const reviewed = opt(args, 'reviewed', v => typeof v === 'boolean', 'true or false');
        const e = engine(args);
        const sid = sessionId(args);
        const obj = need(args, 'object_id', isNat, 'an object id');
        const frame = need(args, 'frame', isNat, 'a frame number');
        const out = await post('/set_reviewed', {
          session_id: sid, object_id: obj, frame,
          ...(reviewed != null ? {reviewed} : {}), ...(span ? {span} : {}), ...(e ? {engine: e} : {}),
        });
        change(sid, 'review', [obj], {frame, state: reviewed === false ? 'unreviewed' : 'reviewed'});
        return text(out);
      },
    },
    sam_capture: {
      async frame(args) {
        const sid = sessionId(args);
        const v = studioOn(sid);
        const frame = args.frame == null && v != null ? v.frame
          : need(args, 'frame', isNat, v == null && args.frame == null ? 'given: studio is not on this video' : 'a frame number (from 0)');
        const {body, hidden} = await common(sid, args);
        return pictured(await post('/capture', {...body, frames: [frame]}), hidden.length > 0 ? {hidden} : undefined);
      },
      async sheet(args) {
        const sid = sessionId(args);
        const frames = opt(args, 'frames', v => Array.isArray(v) && v.length >= 1 && v.length <= 12 && v.every(isNat), '1 to 12 frame numbers');
        const which = frames ? {frames} : {
          start: need(args, 'start', isNat, 'a frame number (or give frames)'),
          end: need(args, 'end', isNat, 'a frame number'),
          count: need(args, 'count', v => isInt(v) && v >= 1 && v <= 12, '1 to 12'),
        };
        const {body, hidden} = await common(sid, args);
        return pictured(await post('/capture', {...body, sheet: true, ...which}), hidden.length > 0 ? {hidden} : undefined);
      },
    },
    sam_studio: {
      async state() {
        const v = view();
        if (v == null) return text({open: false});
        let name = null;
        if (v.active_object != null) {
          name = (await names(v.session_id).catch(() => ({})))[String(v.active_object)] ?? null;
        }
        const {open, active_object, ...rest} = v;
        return text({open, ...rest, active_object: active_object == null ? null : {id: active_object, name}});
      },
    },
  };

  /**
   * /capture's body (session, object_ids, engine, long_edge) and the ids left out
   * as hidden. On studio's session the person's view fills what the args leave
   * out: their colours, their engine (not the browser one, which the backend
   * lacks), and every object but their hidden ones.
   */
  async function common(sid, args) {
    let ids = objectIds(args);
    let e = engine(args);
    const edge = opt(args, 'long_edge', v => isInt(v) && v >= 64, 'a whole number of pixels, 64 or more');
    const v = studioOn(sid);
    let hidden = [];
    if (v != null) {
      if (e == null && v.engine !== BROWSER_ENGINE) e = v.engine;
      if (ids == null && v.hidden_objects.length > 0) {
        const all = (await backend.graphql('query($s: String!) { objectTracks(sessionId: $s) { objectId } }', {s: sid}))
          .objectTracks.map(o => o.objectId);
        hidden = all.filter(id => v.hidden_objects.includes(id));
        if (hidden.length > 0) ids = all.filter(id => !hidden.includes(id));
      }
    }
    const body = look(sid, {session_id: sid, ...(ids ? {object_ids: ids} : {}), ...(e ? {engine: e} : {}), ...(edge ? {long_edge: edge} : {})});
    return {body, hidden};
  }

  async function exportTool(args) {
    const name = need(args, 'name', v => typeof v === 'string' && EXPORT_NAME.test(v),
      'a folder name: letters, digits, ".", "_" and "-", up to 64, starting with a letter or digit');
    const ids = objectIds(args);
    const e = engine(args);
    const outDir = path.join(exportRoot, name);
    const shown = `~/Movies/sam-ui/${name}`;
    let r;
    try {
      r = await post('/export', {
        session_id: sessionId(args), out_dir: outDir,
        ...(ids ? {objects: Object.fromEntries(ids.map(id => [String(id), {}]))} : {}),
        ...(e ? {engine: e} : {}), ...(args.union === true ? {union: true} : {}),
        // never force: an existing folder may hold mattes a person repaired by hand
      });
    } catch (err) {
      // the backend's refusal names the full path and studio's Replace existing, which agents don't have
      if (!(err instanceof ToolError)) throw err;
      throw new ToolError(err.message.replaceAll(`'${outDir}'`, shown).replaceAll(outDir, shown)
        .replace(/; tick Replace existing \(force\) to replace them$/, '. Agents never replace an export: pick a new name.'));
    }
    const {out_dir: _dir, video_path: _vp, ...manifest} = r;
    change(args.session_id, 'export', ids ?? [], {name});
    return text({exported_to: shown, ...manifest});
  }

  async function callTool(name, args) {
    try {
      if (args == null || typeof args !== 'object' || Array.isArray(args)) throw new ToolError('arguments must be an object');
      if (name === 'sam_export') return await exportTool(args);
      const table = Object.hasOwn(commands, name) ? commands[name] : null;
      if (!table) return failure(`Unknown tool: ${name}`);
      const fn = Object.hasOwn(table, args.command) ? table[args.command] : null;
      if (!fn) return failure(`${name}: command must be one of ${Object.keys(table).join(', ')}`);
      return await fn(args);
    } catch (err) {
      // studio's session went with the video the person left: the agent opens its own
      if (shared.has(args?.session_id) && /Cannot find session/.test(String(err?.message))) {
        return failure(SHARED_GONE);
      }
      return failure(err instanceof ToolError ? err.message : `${name} failed: ${err.message}`);
    }
  }

  /** Destroy every held stream (the backend cancels a job whose reader goes) and forget them. */
  function close() {
    for (const job of held.values()) job.res.destroy();
    held.clear();
  }

  return {tools: TOOLS, callTool, close};
}

/** The closing {"done": ...} part of a track stream's last text, or a failure when there is none. */
function closingPart(tail) {
  const at = tail.indexOf('\r\n\r\n');
  if (at >= 0) {
    try {
      const body = JSON.parse(Buffer.from(tail.slice(at + 4), 'latin1').toString('utf8').trim());
      if ('done' in body) return body;
    } catch {
      // a frame part cut short
    }
  }
  return {done: false, error: 'the stream ended without a result'};
}

module.exports = {EXPORT_NAME, INSTRUCTIONS, TOOLS, closingPart, createTools, parseView};
