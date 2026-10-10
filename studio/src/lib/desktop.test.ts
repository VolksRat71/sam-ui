// sam-ui (Apache-2.0). New file, not from SAM 2.
import {afterEach, describe, expect, it} from 'vitest';
import {agentBridge, asAgentChange, asAgentGoto, asAgentTrack} from './desktop';

describe('agentBridge', () => {
  const g = globalThis as {samUiDesktop?: unknown};
  afterEach(() => {
    delete g.samUiDesktop;
  });

  it('is null in a browser and for an older desktop app', () => {
    expect(agentBridge()).toBeNull();
    g.samUiDesktop = {setupSam3: () => {}};
    expect(agentBridge()).toBeNull();
    g.samUiDesktop = {setupSam3: () => {}, agent: {report: () => {}}};
    expect(agentBridge()).toBeNull();
  });

  it('is the bridge when the desktop app exposes it', () => {
    const agent = {report: () => {}, onChanged: () => () => {}};
    g.samUiDesktop = {setupSam3: () => {}, agent};
    expect(agentBridge()).toBe(agent);
  });
});

describe('asAgentGoto', () => {
  it('reads a frame, a layer or both, and nothing else', () => {
    expect(asAgentGoto({id: 1, video_id: 'v.mp4', frame: 3, object_id: null})).toEqual({videoId: 'v.mp4', frame: 3, objectId: null});
    expect(asAgentGoto({video_id: 'v.mp4', frame: null, object_id: 2})).toEqual({videoId: 'v.mp4', frame: null, objectId: 2});
    for (const bad of [null, [], {video_id: 'v.mp4'}, {video_id: '', frame: 1}, {video_id: 'v.mp4', frame: -1}, {video_id: 'v.mp4', object_id: '2'}]) {
      expect(asAgentGoto(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('asAgentTrack', () => {
  it('reads ids or none, and an engine or none', () => {
    expect(asAgentTrack({id: 2, video_id: 'v.mp4', object_ids: [0, 3], engine: 'sam3'})).toEqual({videoId: 'v.mp4', objectIds: [0, 3], engine: 'sam3'});
    expect(asAgentTrack({video_id: 'v.mp4', object_ids: null, engine: null})).toEqual({videoId: 'v.mp4', objectIds: null, engine: null});
    for (const bad of [null, {}, {video_id: 'v.mp4', object_ids: [-1]}, {video_id: 'v.mp4', engine: 'SAM 3'}, {video_id: 'v.mp4', object_ids: '1'}]) {
      expect(asAgentTrack(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('asAgentChange', () => {
  const sent = {video_id: 'gallery/03_blocks.mp4', kind: 'range', object_ids: [2], frame: 3, end: 9, state: 'absent', at: 1};

  it('reads what main sends', () => {
    expect(asAgentChange(sent)).toEqual({
      videoId: 'gallery/03_blocks.mp4', kind: 'range', objectIds: [2], frame: 3, end: 9, state: 'absent', jobId: null, name: null, at: 1,
    });
    expect(asAgentChange({...sent, kind: 'track_start', frame: undefined, end: undefined, state: undefined, job_id: 'job-7'})).toMatchObject({
      kind: 'track_start', frame: null, end: null, state: null, jobId: 'job-7',
    });
    expect(asAgentChange({...sent, kind: 'export', object_ids: [], name: 'blocks-73'})?.name).toBe('blocks-73');
  });

  it('refuses anything malformed', () => {
    for (const bad of [
      null, 'points', [sent], {},
      {...sent, video_id: ''}, {...sent, video_id: 7}, {...sent, video_id: 'x'.repeat(513)},
      {...sent, kind: 'delete_everything'}, {...sent, kind: '__proto__'},
      {...sent, object_ids: [-1]}, {...sent, object_ids: '2'}, {...sent, object_ids: [1.5]},
      {...sent, frame: -1}, {...sent, frame: '3'}, {...sent, end: 2 ** 60},
      {...sent, state: 'gone'}, {...sent, job_id: '../x'}, {...sent, name: '../up'}, {...sent, name: 7},
      {...sent, at: 'now'}, {...sent, at: Infinity},
    ]) {
      expect(asAgentChange(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
