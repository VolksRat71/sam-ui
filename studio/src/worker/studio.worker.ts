/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Modified by sam-ui: adapted from VideoWorker.ts in Meta's SAM 2 demo frontend;
// the video messages are Meta's, the tracker is replaced by studio's RPC calls,
// highlight effects are per object (ObjectHighlight), and the export is
// studio's own encoder (exportVideo.ts).
import AllEffects, {type Effects} from '@/common/components/video/effects/Effects';
import VideoWorkerContext from '@/common/components/video/VideoWorkerContext';
import type {VideoWorkerRequestMessageEvent} from '@/common/components/video/VideoWorkerTypes';
import {registerSerializableConstructors} from '@/common/error/ErrorSerializationUtils';
import type {CanvasForm} from 'pts';
import {serializeError} from 'serialize-error';
import {encodeMp4} from './exportVideo';
import MaskOverlayEffect from './MaskOverlayEffect';
import ObjectHighlight from './ObjectHighlight';
import type {
  StudioCall,
  StudioEvent,
  StudioEventMessage,
  StudioMethod,
  StudioMethods,
  StudioReply,
} from './protocol';
import StudioSession from './StudioSession';

registerSerializableConstructors();

// Meta's context draws [background, highlight]. Its highlight effects apply
// one effect to every object (and its Overlay shader holds three masks), so
// the highlight slot gets studio's ObjectHighlight, which draws each object
// with its own effect, before the context reads it. Meta's highlight effects
// stay in `metaEffects` for ObjectHighlight to run.
const metaEffects: Effects = {...AllEffects};
const overlay = new MaskOverlayEffect();
const highlight = new ObjectHighlight(overlay, metaEffects, () => ({width: context.width, height: context.height}));
AllEffects.Overlay = highlight;

const context = new VideoWorkerContext();

/** The effects the preview shows; an export swaps in its own, then restores these. */
let previewEffects: Record<number, {name: string; variant: number}> = {};
let exporting = false;
/** The preview's hidden objects (a hidden group's members); an export draws them all. */
let previewHidden: (id: number) => boolean = () => false;

async function exportVideo(effects: Record<number, {name: string; variant: number}>): Promise<ArrayBuffer> {
  // Meta's context keeps its decoded frames and its frame renderer private;
  // bracket access uses them without copying the class.
  const decoded = context['_decodedVideo'];
  if (decoded == null || decoded.frames.length < decoded.numFrames) {
    throw new Error('the video is still decoding');
  }
  if (exporting) {
    throw new Error('an export is already running');
  }
  exporting = true;
  const active = overlay.activeObjectId;
  const faded = overlay.faded;
  overlay.activeObjectId = null; // no editing aids in the file
  overlay.faded = () => false;
  highlight.hidden = () => false; // hiding a group is for the preview only
  try {
    await highlight.setEffects(effects);
    return await encodeMp4({
      width: context.width,
      height: context.height,
      fps: decoded.fps,
      numFrames: decoded.frames.length,
      // the renderer the preview uses, without Meta's watermark
      draw: (form: CanvasForm, index: number) => context['_drawFrameImpl'](form, index, false),
      onProgress: done => emit({type: 'exportProgress', done}),
    });
  } finally {
    overlay.activeObjectId = active;
    overlay.faded = faded;
    highlight.hidden = previewHidden;
    await highlight.setEffects(previewEffects);
    exporting = false;
    context.goToFrame(context.frameIndex);
  }
}

function emit(event: StudioEvent): void {
  const message: StudioEventMessage = {action: 'studioEvent', event};
  self.postMessage(message);
}
const session = new StudioSession(context, overlay, emit);

type Handlers = {
  [M in StudioMethod]: (
    args: StudioMethods[M]['args'],
  ) => Promise<StudioMethods[M]['result']> | StudioMethods[M]['result'];
};

const handlers: Handlers = {
  init: ({endpoint, offline}) => session.init(endpoint, offline),
  startSession: ({path, key}) => session.startSession(path, key),
  closeSession: () => session.closeSession(),
  setPoints: ({objectId, frameIndex, points, engine}) =>
    session.setPoints(objectId, frameIndex, points, engine),
  textPrompt: ({objectId, frameIndex, text, engine}) => session.textPrompt(objectId, frameIndex, text, engine),
  removeObject: ({objectId}) => session.removeObject(objectId),
  clearTrack: ({objectId, engine}) => session.clearTrack(objectId, engine),
  setRange: ({objectId, start, end, state, source, score, clear}) => session.setRange(objectId, start, end, state, {source, score, clear}),
  writeCandidates: ({objectId, candidates, replace}) => session.writeCandidates(objectId, candidates, replace),
  objectTracks: () => session.objectTracks(),
  undo: ({objectId}) => session.undo(objectId),
  redo: ({objectId}) => session.redo(objectId),
  restoreVersion: ({objectId, key, engine}) => session.restoreVersion(objectId, key, engine),
  moveClicks: ({frameIndex, fromId, toId, engine}) => session.moveClicks(frameIndex, fromId, toId, engine),
  track: ({objectIds, key, engine}) => session.track(objectIds, key, engine),
  cancelTrack: ({jobId}) => session.cancelTrack(jobId),
  trackJobs: () => session.trackJobs(),
  repaint: ({objectIds}) => session.repaint(objectIds),
  startOver: () => session.startOver(),
  export: request => session.exportFolder(request),
  setActiveObject: ({objectId}) => session.setActiveObject(objectId),
  setObjectColors: ({colors}) => session.setObjectColors(colors),
  setStaleObjects: ({objectIds}) => session.setStaleObjects(objectIds),
  setEngine: ({engine}) => session.setEngine(engine),
  engines: () => session.engines(),
  disagreement: ({a, b, objectIds}) => session.disagreement(a, b, objectIds),
  reviewQueue: ({engine, flags, candidates}) => session.reviewQueue(engine, flags, candidates),
  setReviewed: args => session.setReviewed(args),
  setObjectEffects: async ({effects}) => {
    previewEffects = effects;
    if (!exporting) {
      await highlight.setEffects(effects);
      context.goToFrame(context.frameIndex);
    }
  },
  effectVariants: ({names}) => highlight.variantCounts(names),
  exportVideo: ({effects}) => exportVideo(effects),
  setLocalOptions: options => session.setLocalOptions(options),
  renameObject: ({objectId, name}) => session.renameObject(objectId, name),
  exportMasks: args => session.exportMasks(args),
  objectNames: () => session.objectNames(),
  objectLayout: () => session.objectLayout(),
  setObjectLayout: ({layout}) => session.setObjectLayout(layout),
  setHiddenObjects: ({objectIds}) => {
    const hidden = new Set(objectIds);
    previewHidden = id => hidden.has(id);
    if (!exporting) {
      highlight.hidden = previewHidden;
      context.goToFrame(context.frameIndex);
    }
  },
};

async function handleCall(call: StudioCall): Promise<void> {
  let reply: StudioReply;
  try {
    const handler = handlers[call.method] as (args: unknown) => unknown;
    const value = await handler(call.args);
    reply = {action: 'studioReply', id: call.id, ok: true, value};
  } catch (error) {
    reply = {
      action: 'studioReply',
      id: call.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  self.postMessage(reply);
}

self.addEventListener(
  'message',
  async (event: VideoWorkerRequestMessageEvent | MessageEvent<StudioCall>) => {
    const data = event.data;
    if (data.action === 'studioCall') {
      await handleCall(data);
      return;
    }
    try {
      switch (data.action) {
        case 'setCanvas':
          context.setCanvas(data.canvas);
          break;
        case 'setSource':
          context.setSource(data.source);
          break;
        case 'play':
          context.play();
          break;
        case 'pause':
          context.pause();
          break;
        case 'stop':
          context.stop();
          break;
        case 'frameUpdate':
          context.goToFrame(data.index);
          break;
        case 'filmstrip':
          await context.createFilmstrip(data.width, data.height);
          break;
        case 'setEffect':
          // the background; highlights are per object (setObjectEffects)
          await context.setEffect(data.name, data.index, data.options);
          break;
      }
    } catch (error) {
      self.postMessage({action: 'error', error: serializeError(error)});
    }
  },
);
