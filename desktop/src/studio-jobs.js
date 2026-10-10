// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Agent tracks that studio runs itself (issue #73): main asks the window
// (agent:track) and studio answers through agent:track-reply, first started
// or refused, then done. No require('electron'), so the replies' order is
// tested on its own (test/studio-jobs.test.js).
'use strict';

const {parseTrackReply} = require('./mcp-tools');

/**
 * `send(request)` posts to the window and answers false when there is none.
 * track(req) resolves {job_id, objects, bounded, done: a Promise of the
 * result} once studio started the job, {error} when it refused (a done before
 * any start counts as a refusal), or null (no window, or no word within
 * `timeoutMs`): then the tools read the stream themselves.
 */
function createStudioJobs({send, timeoutMs = 30000}) {
  let seq = 0;
  const waits = new Map(); // id -> {started(reply), ended(result)}

  function track(req) {
    return new Promise(resolve => {
      const id = ++seq;
      let ended;
      const done = new Promise(r => (ended = r));
      // ponytail: a studio that answers after the timeout still starts its job, beside the tools' own
      const timer = setTimeout(() => {
        waits.delete(id);
        resolve(null);
      }, timeoutMs);
      waits.set(id, {
        started: reply => {
          clearTimeout(timer);
          resolve(reply == null ? null : reply.error != null ? {error: reply.error} : {...reply, done});
        },
        ended,
      });
      if (!send({id, ...req})) {
        waits.get(id).started(null);
        waits.delete(id);
      }
    });
  }

  /** One agent:track-reply from studio, already known to come from the main window. */
  function reply(msg) {
    const w = Number.isInteger(msg?.id) ? waits.get(msg.id) : undefined;
    const r = w != null ? parseTrackReply(msg) : null;
    if (r == null) return;
    if (r.stage === 'started') w.started({job_id: r.job_id, objects: r.objects, bounded: r.bounded});
    // a refusal, or a done before any start (studio left the video first): the agent hears why at once
    if (r.stage === 'refused') w.started({error: r.error});
    if (r.stage === 'done') w.started({error: r.result.error ?? 'the track ended before it started'});
    if (r.stage !== 'started' || r.job_id == null) {
      w.ended(r.result ?? {done: false, error: r.error ?? 'nothing to track'});
      waits.delete(msg.id);
    }
  }

  /** The window reloaded or crashed: its jobs went with it. */
  function drop() {
    for (const w of waits.values()) {
      w.started(null);
      w.ended({done: false, error: 'studio closed the video'});
    }
    waits.clear();
  }

  return {track, reply, drop};
}

module.exports = {createStudioJobs};
