// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import type {AgentChange, AgentTrack} from '~/lib/desktop';
import {type ServerObject, dirtyOn} from '~/state/objects';
import {ACTIVITY_LIMIT, ageLabel, appendActivity, describeChange, describeEntry, planAgentTrack, viewReport} from './agentActivity';

const change = (c: Partial<AgentChange>): AgentChange => ({
  videoId: 'gallery/03_blocks.mp4', kind: 'points', objectIds: [1], frame: 120, end: null, state: null, jobId: null, name: null, at: 0, ...c,
});
const nameOf = (id: number) => (id === 1 ? 'Blocks 2' : `Object ${id + 1}`);

describe('appendActivity', () => {
  it('puts the newest on top and keeps the last 20', () => {
    let list = appendActivity([], change({frame: 0}), null);
    for (let i = 1; i < 30; i++) {
      list = appendActivity(list, change({frame: i}), null);
    }
    expect(list).toHaveLength(ACTIVITY_LIMIT);
    expect(list[0].change.frame).toBe(29);
    expect(new Set(list.map(e => e.id)).size).toBe(ACTIVITY_LIMIT);
  });

  it('folds clicks set again on the same layer and frame into one row', () => {
    let list = appendActivity([], change({}), null);
    list = appendActivity(list, change({at: 5}), null);
    expect(list).toHaveLength(1);
    expect(list[0].change.at).toBe(5);
    list = appendActivity(list, change({frame: 121}), null);
    list = appendActivity(list, change({kind: 'undo', frame: null}), null);
    list = appendActivity(list, change({kind: 'undo', frame: null}), null);
    expect(list.map(e => e.change.kind)).toEqual(['undo', 'undo', 'points', 'points']); // two undos are two steps
  });

  it('notes a change to the layer the person has selected', () => {
    expect(appendActivity([], change({}), 1)[0].onSelected).toBe(true);
    expect(appendActivity([], change({}), 4)[0].onSelected).toBe(false);
    expect(appendActivity([], change({}), null)[0].onSelected).toBe(false);
  });
});

describe('describeChange', () => {
  it('says each kind in studio\'s words, with 1-based frames', () => {
    const cases: Array<[Partial<AgentChange>, string]> = [
      [{}, 'set clicks on Blocks 2, frame 121'],
      [{kind: 'text', frame: 0}, 'set Blocks 2 from a phrase, frame 1'],
      [{kind: 'range', frame: 3, end: 9, state: 'absent'}, 'marked Blocks 2 absent, frames 4–10'],
      [{kind: 'range', frame: 3, end: 3, state: 'present'}, 'marked Blocks 2 present, frame 4'],
      [{kind: 'range', frame: 3, end: 9, state: 'clear'}, 'cleared the marks on Blocks 2, frames 4–10'],
      [{kind: 'undo', frame: null}, 'undid the last change on Blocks 2'],
      [{kind: 'redo', frame: null}, 'redid the last change on Blocks 2'],
      [{kind: 'remove', frame: null}, 'removed Blocks 2'],
      [{kind: 'track_start', frame: null, objectIds: [1, 2]}, 'started tracking Blocks 2, Object 3'],
      [{kind: 'track_done', frame: null, state: 'done'}, 'tracked Blocks 2'],
      [{kind: 'track_done', frame: null, state: 'failed'}, 'could not finish tracking Blocks 2'],
      [{kind: 'track_cancel', frame: null}, 'cancelled tracking Blocks 2'],
      [{kind: 'review', frame: 40, state: 'reviewed'}, 'marked frame 41 of Blocks 2 reviewed'],
      [{kind: 'review', frame: 40, state: 'unreviewed'}, 'unmarked frame 41 of Blocks 2 as reviewed'],
      [{kind: 'export', frame: null, objectIds: [], name: 'blocks-73'}, 'exported every tracked layer to blocks-73'],
      [{kind: 'track_start', frame: null, objectIds: [1, 2, 3, 4, 5]}, 'started tracking Blocks 2, Object 3, Object 4 and 2 more'],
      [{kind: 'goto', frame: 40, objectIds: []}, 'moved you to frame 41'],
      [{kind: 'goto', frame: 40}, 'moved you to Blocks 2, frame 41'],
      [{kind: 'goto', frame: null}, 'moved you to Blocks 2'],
    ];
    for (const [c, words] of cases) {
      expect(describeChange(change(c), nameOf)).toBe(words);
    }
  });

  it('calls out the person\'s selected layer', () => {
    expect(describeEntry(appendActivity([], change({}), 1)[0], nameOf)).toBe('set clicks on Blocks 2, frame 121 (your selected layer)');
  });

  it('says a change\'s age briefly', () => {
    expect([0, 4_000, 40_000, 200_000, 7_300_000].map(ageLabel)).toEqual(['now', 'now', '40 s', '3 min', '2 h']);
  });

});

describe('planAgentTrack', () => {
  const at = {videoPath: 'gallery/03_blocks.mp4', ready: true};
  const ask = (c: Partial<AgentTrack>): AgentTrack => ({videoId: 'gallery/03_blocks.mp4', objectIds: null, engine: null, ...c});
  const stale2 = (objectId: number, sam2: string, sam3: string): ServerObject => ({
    objectId, state: sam2, frames: null, nFrames: 0, seeds: [{frameIndex: 0, points: [[0.5, 0.5]], labels: [1]}],
    tracks: [{engine: 'sam2', state: sam2, frames: null, nFrames: 0}, {engine: 'sam3', state: sam3, frames: null, nFrames: 0}],
  });

  it('with no ids and the person on SAM 3, picks what is dirty on SAM 2, the job\'s engine', () => {
    const plan = planAgentTrack(ask({}), at);
    expect(plan).toEqual({engine: 'sam2', ids: null});
    const objects = [stale2(1, 'stale', 'tracked'), stale2(2, 'tracked', 'stale')];
    expect(dirtyOn(objects, (plan as {engine: string}).engine)).toEqual([1]);
  });

  it('keeps the agent\'s ids and engine, and refuses the browser engine or another video', () => {
    expect(planAgentTrack(ask({objectIds: [4], engine: 'sam3'}), at)).toEqual({engine: 'sam3', ids: [4]});
    expect(planAgentTrack(ask({engine: 'browser-sam2'}), at)).toHaveProperty('refuse');
    expect(planAgentTrack(ask({videoId: 'gallery/01_dog.mp4'}), at)).toEqual({refuse: 'studio is not on that video'});
    expect(planAgentTrack(ask({}), {...at, ready: false})).toHaveProperty('refuse');
    expect(planAgentTrack(null, at)).toHaveProperty('refuse');
  });
});

describe('viewReport', () => {
  const base = {
    videoId: 'gallery/03_blocks.mp4', sessionId: 's1', frame: 12, numFrames: 300, playing: false, activeId: 1,
    engine: 'sam2', hiddenIds: [4, 2, 4], colors: {1: '#ff00ff'}, nextObjectId: 6,
  };

  it('reports what the person sees', () => {
    expect(viewReport(base)).toEqual({
      open: true, video_id: 'gallery/03_blocks.mp4', session_id: 's1', frame: 12, n_frames: 300, playing: false,
      active_object: 1, engine: 'sam2', hidden_objects: [2, 4], colors: {1: '#ff00ff'}, next_object_id: 6,
    });
  });

  it('is closed until the session and the clip length are known, and keeps the frame in the clip', () => {
    expect(viewReport({...base, sessionId: null})).toEqual({open: false});
    expect(viewReport({...base, numFrames: 0})).toEqual({open: false});
    expect(viewReport({...base, frame: 400})).toMatchObject({frame: 299});
  });
});
