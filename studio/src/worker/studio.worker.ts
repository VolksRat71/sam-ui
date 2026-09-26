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
// Modified by sam-ui: adapted from demo/frontend/src/common/components/video/VideoWorker.ts;
// the video messages are Meta's, the tracker is replaced by studio's RPC calls,
// and highlight effects go through FocusedHighlight (the focused object only).
import AllEffects, {type Effects} from '@/common/components/video/effects/Effects';
import VideoWorkerContext from '@/common/components/video/VideoWorkerContext';
import type {VideoWorkerRequestMessageEvent} from '@/common/components/video/VideoWorkerTypes';
import {registerSerializableConstructors} from '@/common/error/ErrorSerializationUtils';
import {serializeError} from 'serialize-error';
import FocusedHighlight from './FocusedHighlight';
import MaskOverlayEffect from './MaskOverlayEffect';
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

// Meta's context draws [Original, Overlay]. Its Overlay shader holds three
// masks and its other highlights apply to every object, so the highlight slot
// gets studio's FocusedHighlight instead, before the context reads it. Meta's
// highlight effects stay in `metaEffects` for FocusedHighlight to run.
const metaEffects: Effects = {...AllEffects};
const overlay = new MaskOverlayEffect();
const highlight = new FocusedHighlight(overlay);
AllEffects.Overlay = highlight;

const context = new VideoWorkerContext();

const HIGHLIGHT = 1; // Meta's EffectIndex.HIGHLIGHT

/** A highlight effect, applied through FocusedHighlight; Overlay means none. */
async function setHighlight(name: keyof Effects, options?: {variant: number}): Promise<void> {
  // Meta's context keeps its WebGL highlight canvas private; bracket access
  // reads it without copying the class. Present once the first frame decoded.
  const canvas = context['_canvasHighlights'];
  const gl = context['_glObjects'];
  const init = canvas != null && gl != null ? {width: context.width, height: context.height, canvas, gl} : null;
  await highlight.use(name === 'Overlay' ? null : metaEffects[name], init, options);
  const shown = highlight.current;
  self.postMessage({
    action: 'effectUpdate',
    name,
    index: HIGHLIGHT,
    variant: shown.variant,
    numVariants: shown.numVariants,
  });
  context.goToFrame(context.frameIndex);
}
const session = new StudioSession(context, overlay, (event: StudioEvent) => {
  const message: StudioEventMessage = {action: 'studioEvent', event};
  self.postMessage(message);
});

type Handlers = {
  [M in StudioMethod]: (
    args: StudioMethods[M]['args'],
  ) => Promise<StudioMethods[M]['result']> | StudioMethods[M]['result'];
};

const handlers: Handlers = {
  init: ({endpoint}) => session.init(endpoint),
  startSession: ({path}) => session.startSession(path),
  closeSession: () => session.closeSession(),
  setPoints: ({objectId, frameIndex, points}) =>
    session.setPoints(objectId, frameIndex, points),
  removeObject: ({objectId}) => session.removeObject(objectId),
  clearTrack: ({objectId, engine}) => session.clearTrack(objectId, engine),
  objectTracks: () => session.objectTracks(),
  track: ({objectIds, key, engine}) => session.track(objectIds, key, engine),
  cancelTrack: ({jobId}) => session.cancelTrack(jobId),
  trackJobs: () => session.trackJobs(),
  repaint: ({objectIds}) => session.repaint(objectIds),
  startOver: () => session.startOver(),
  export: request => session.exportFolder(request),
  setActiveObject: ({objectId}) => session.setActiveObject(objectId),
  setEngine: ({engine}) => session.setEngine(engine),
  engines: () => session.engines(),
  disagreement: ({a, b, objectIds}) => session.disagreement(a, b, objectIds),
  setEffectFocus: ({objectId}) => {
    highlight.focusId = objectId;
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
          if (data.index === HIGHLIGHT) {
            await setHighlight(data.name, data.options);
          } else {
            await context.setEffect(data.name, data.index, data.options);
          }
          break;
        case 'encode':
          await context.encode();
          break;
      }
    } catch (error) {
      self.postMessage({action: 'error', error: serializeError(error)});
    }
  },
);
