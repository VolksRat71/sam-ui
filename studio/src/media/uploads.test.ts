// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it, vi} from 'vitest';
import {IDLE, UploadQueue, type UploadDeps, type UploadState} from './uploads';
import type {VideoItem} from '~/workspace/useStudioSession';

const VIDEO: VideoItem = {path: 'clip.mp4', url: '/clip.mp4', width: 640, height: 360, posterUrl: null};

function file(mb = 1): File {
  return {size: mb * 1024 ** 2, name: 'clip.mp4'} as File;
}

function setup() {
  let state: UploadState = IDLE;
  const queue = new UploadQueue(update => {
    state = {...state, ...update};
  });
  return {queue, state: () => state};
}

function deps(overrides: Partial<UploadDeps> = {}): UploadDeps {
  return {
    limits: {maxSeconds: 10, maxMb: 70, over: 'trim'},
    readDuration: async () => 5,
    add: async () => VIDEO,
    onAdded: () => {},
    ...overrides,
  };
}

describe('UploadQueue', () => {
  it('runs an upload and hands the video on', async () => {
    const {queue, state} = setup();
    const onAdded = vi.fn();
    await queue.start(file(), deps({onAdded}));
    expect(onAdded).toHaveBeenCalledWith(VIDEO);
    expect(state()).toEqual(IDLE);
  });

  it('refuses a second upload while one runs, whoever asks (a remounted Media section included)', async () => {
    const {queue, state} = setup();
    let finish!: (v: VideoItem) => void;
    const add = vi.fn(() => new Promise<VideoItem>(r => (finish = r)));
    const first = queue.start(file(), deps({add}));
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(state().uploading).toBe(true);
    expect(await queue.start(file(), deps({add}))).toBe(false);
    expect(add).toHaveBeenCalledTimes(1);
    finish(VIDEO);
    await first;
    expect(state().uploading).toBe(false);
    expect(await queue.start(file(), deps({add: async () => VIDEO}))).toBe(true);
  });

  it('reports a file over the size limit without uploading it', async () => {
    const {queue, state} = setup();
    const add = vi.fn(async () => VIDEO);
    await queue.start(file(100), deps({add}));
    expect(add).not.toHaveBeenCalled();
    expect(state().error?.text).toMatch(/too large/);
    expect(state().uploading).toBe(false);
  });

  it('keeps a failed upload as its error, and unlocks', async () => {
    const {queue, state} = setup();
    await queue.start(file(), deps({add: async () => Promise.reject(new Error('disk full'))}));
    expect(state()).toEqual({uploading: false, error: {text: 'disk full', desktop: false}, notice: null});
  });

  it('says a long clip will be trimmed', async () => {
    const {queue, state} = setup();
    await queue.start(file(), deps({readDuration: async () => 60}));
    expect(state().notice).not.toBeNull();
  });
});
