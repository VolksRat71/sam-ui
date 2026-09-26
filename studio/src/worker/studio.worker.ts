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
// the video messages are Meta's, the tracker is replaced by studio's RPC calls.
import AllEffects from '@/common/components/video/effects/Effects';
import VideoWorkerContext from '@/common/components/video/VideoWorkerContext';
import type {VideoWorkerRequestMessageEvent} from '@/common/components/video/VideoWorkerTypes';
import {registerSerializableConstructors} from '@/common/error/ErrorSerializationUtils';
import {serializeError} from 'serialize-error';
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

// Meta's context draws [Original, Overlay]; its Overlay shader holds three
// masks. Swap in studio's many-mask overlay before the context reads it.
const overlay = new MaskOverlayEffect();
AllEffects.Overlay = overlay;

const context = new VideoWorkerContext();
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
  clearTrack: ({objectId}) => session.clearTrack(objectId),
  objectTracks: () => session.objectTracks(),
  track: ({objectIds, key}) => session.track(objectIds, key),
  cancelTrack: ({jobId}) => session.cancelTrack(jobId),
  trackJobs: () => session.trackJobs(),
  repaint: ({objectIds}) => session.repaint(objectIds),
  startOver: () => session.startOver(),
  export: request => session.exportFolder(request),
  setActiveObject: ({objectId}) => session.setActiveObject(objectId),
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
          await context.setEffect(data.name, data.index, data.options);
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
