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
// effects are studio's effect clips (ObjectHighlight), and the export is
// studio's own encoder (exportVideo.ts).
import AllEffects, {createEffects} from '@/common/components/video/effects/Effects';
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
import {type EffectDoc, type UntouchedMode, isImageHash} from '~/state/effectClips';

registerSerializableConstructors();

// Meta's context draws [background, highlight]. Its highlight effects apply
// one effect to every object (and its Overlay shader holds three masks), so
// the highlight slot gets studio's ObjectHighlight, which draws the effect
// clips (background clips, then each object's), before the context reads it.
// ObjectHighlight runs instances of its own: it sets their style and params,
// which must never reach the ones Meta's background slot draws.
const metaEffects = createEffects();
const overlay = new MaskOverlayEffect();
const highlight = new ObjectHighlight(overlay, metaEffects, () => ({width: context.width, height: context.height}));
AllEffects.Overlay = highlight;

const context = new VideoWorkerContext();
// the earlier frames the effect clips on a frame draw from (Echo), fetched before each draw, preview and export alike
context.historyFrames = (form, frameIndex) => highlight.historyFor(form, frameIndex);

let exporting = false;

async function exportVideo(doc: EffectDoc, drawOrder: number[], untouched: UntouchedMode): Promise<ArrayBuffer> {
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
  // the export's own copy of the clips: no editing aids, hidden groups
  // drawn, and anything changed meanwhile reaches only the preview
  const state = {doc, drawOrder, untouched};
  try {
    await highlight.prepare(state);
    return await encodeMp4({
      width: context.width,
      height: context.height,
      fps: decoded.fps,
      numFrames: decoded.frames.length,
      // the renderer the preview uses, without Meta's watermark
      draw: async (form: CanvasForm, index: number) => {
        highlight.drawWith(form, state);
        if (!(await context['_drawFrameImpl'](form, index, false))) {
          throw new Error(`Frame ${index + 1} could not be drawn, so the export stopped.`);
        }
      },
      onProgress: done => emit({type: 'exportProgress', done}),
    });
  } finally {
    exporting = false;
    await highlight.finish(state);
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
  detailRequest: ({operation, args}) => session.detailRequest(operation, args),
  init: ({endpoint, offline}) => session.init(endpoint, offline),
  startSession: ({path, key}) => session.startSession(path, key),
  closeSession: () => session.closeSession(),
  setPoints: ({objectId, frameIndex, points, engine}) =>
    session.setPoints(objectId, frameIndex, points, engine),
  textPrompt: ({objectId, frameIndex, text, engine}) => session.textPrompt(objectId, frameIndex, text, engine),
  discoverText: ({objectId, text, engine}) => session.discoverText(objectId, text, engine),
  removeObject: ({objectId}) => session.removeObject(objectId),
  clearTrack: ({objectId, engine}) => session.clearTrack(objectId, engine),
  setRange: ({objectId, start, end, state, source, score, clear}) => session.setRange(objectId, start, end, state, {source, score, clear}),
  writeCandidates: ({objectId, candidates, replace}) => session.writeCandidates(objectId, candidates, replace),
  objectTracks: () => session.objectTracks(),
  refreshObjects: ({objectIds, busy}) => session.refreshObjects(objectIds, busy),
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
  setEffectDoc: async ({doc, drawOrder}) => {
    await highlight.setDoc(doc, drawOrder);
    context.goToFrame(context.frameIndex);
  },
  setEffectImage: ({key, image}) => {
    if (!isImageHash(key) || !(image instanceof ImageBitmap)) {
      throw new Error('not a picture key and bitmap');
    }
    highlight.images.get(key)?.close();
    highlight.images.set(key, image);
    context.goToFrame(context.frameIndex);
  },
  exportVideo: ({doc, drawOrder, untouched}) => exportVideo(doc, drawOrder, untouched),
  setLocalOptions: options => session.setLocalOptions(options),
  renameObject: ({objectId, name}) => session.renameObject(objectId, name),
  exportMasks: args => session.exportMasks(args),
  objectNames: () => session.objectNames(),
  objectLayout: () => session.objectLayout(),
  setObjectLayout: ({layout}) => session.setObjectLayout(layout),
  setHiddenObjects: ({objectIds}) => {
    const hidden = new Set(objectIds);
    highlight.hidden = id => hidden.has(id); // the preview's only: an export draws every object
    context.goToFrame(context.frameIndex);
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
          // Meta's background slot; studio draws the plain frame there and its
          // background clips over it (ObjectHighlight, setEffectDoc)
          await context.setEffect(data.name, data.index, data.options);
          break;
      }
    } catch (error) {
      self.postMessage({action: 'error', error: serializeError(error)});
    }
  },
);
