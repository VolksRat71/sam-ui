// sam-ui (Apache-2.0). New file, not from SAM 2.
// studio-jobs.js: the order of studio's replies to an agent track it runs.
'use strict';

const assert = require('node:assert');
const {test} = require('node:test');
const {createStudioJobs} = require('../src/studio-jobs');

function jobs(timeoutMs = 1000) {
  const sent = [];
  const j = createStudioJobs({send: r => (sent.push(r), true), timeoutMs});
  return {...j, sent};
}

test('started, then done: the job and its result', async () => {
  const j = jobs();
  const started = j.track({video_id: 'v.mp4', object_ids: [1], engine: null});
  const {id} = j.sent[0];
  assert.deepStrictEqual(j.sent[0], {id, video_id: 'v.mp4', object_ids: [1], engine: null});
  j.reply({id, stage: 'started', job_id: 'job-1', objects: [1], bounded: []});
  const r = await started;
  assert.deepStrictEqual({...r, done: undefined}, {job_id: 'job-1', objects: [1], bounded: [], done: undefined});
  j.reply({id, stage: 'done', result: {done: true, tracked: [1], failed: {}}});
  assert.deepStrictEqual(await r.done, {done: true, tracked: [1], failed: {}});
  j.reply({id, stage: 'done', result: {done: false, error: 'late'}}); // forgotten: nothing happens
});

test('a done before any start (the person left the video) is a refusal at once', async () => {
  const j = jobs(60_000);
  const started = j.track({video_id: 'v.mp4', object_ids: null, engine: null});
  j.reply({id: j.sent[0].id, stage: 'done', result: {done: false, error: 'the person closed this video in studio'}});
  assert.deepStrictEqual(await started, {error: 'the person closed this video in studio'});
});

test('refused, nothing to track, no window and no answer', async () => {
  const j = jobs(30);
  const refused = j.track({});
  j.reply({id: j.sent[0].id, stage: 'refused', error: 'busy'});
  assert.deepStrictEqual(await refused, {error: 'busy'});
  const none = j.track({});
  j.reply({id: j.sent[1].id, stage: 'started', job_id: null, objects: [], bounded: []});
  assert.strictEqual((await none).job_id, null);
  assert.strictEqual(await j.track({}), null); // the timeout: the tools read the stream themselves
  const closed = createStudioJobs({send: () => false});
  assert.strictEqual(await closed.track({}), null);
});

test('a reload or crash drops every job: a waiting start is null, a running job ends', async () => {
  const j = jobs(60_000);
  const waiting = j.track({});
  const running = j.track({});
  j.reply({id: j.sent[1].id, stage: 'started', job_id: 'job-2', objects: [2], bounded: []});
  const r = await running;
  j.drop();
  assert.strictEqual(await waiting, null);
  assert.deepStrictEqual(await r.done, {done: false, error: 'studio closed the video'});
});

test('malformed replies and unknown ids change nothing', async () => {
  const j = jobs(30);
  const started = j.track({});
  for (const bad of [null, {id: 'x'}, {id: 999, stage: 'started', job_id: 'j', objects: [], bounded: []}, {id: j.sent[0].id, stage: 'nope'}]) j.reply(bad);
  assert.strictEqual(await started, null); // still waiting until the timeout
});
