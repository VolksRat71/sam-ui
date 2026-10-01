// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The preview's touch gestures (lib/gestures.ts) as capture-phase pointer
// handlers for the stage, so they see every finger without changing the
// stage's own mouse handlers. A tap is left to the click layer's click.
import {useEffect, useRef, type PointerEvent} from 'react';
import {TouchTracker, type TrackerCallbacks} from '~/lib/gestures';

type Options = TrackerCallbacks & {
  /** whether a long press may start on this element (not on a point marker) */
  canLongPress: (target: EventTarget) => boolean;
};

export default function useTouchGestures(options: Options) {
  // the latest callbacks, read when a gesture fires, so the tracker lives once
  const latest = useRef(options);
  latest.current = options;
  const tracker = useRef<TouchTracker | null>(null);
  if (tracker.current == null) {
    tracker.current = new TouchTracker({
      zoomed: () => latest.current.zoomed(),
      onLongPress: (x, y) => {
        try {
          navigator.vibrate?.(12); // a nudge where the platform has one
        } catch {
          // no vibration: the new point is the feedback
        }
        latest.current.onLongPress(x, y);
      },
      onPan: (dx, dy) => latest.current.onPan(dx, dy),
      onPinch: step => latest.current.onPinch(step),
    });
  }
  const t = tracker.current;
  useEffect(() => () => t.dispose(), [t]);

  const end = (e: PointerEvent<HTMLElement>) => t.up(e.pointerId);
  return {
    handlers: {
      onPointerDownCapture: (e: PointerEvent<HTMLElement>) =>
        t.down(e.pointerId, e.pointerType, e.clientX, e.clientY, latest.current.canLongPress(e.target)),
      onPointerMoveCapture: (e: PointerEvent<HTMLElement>) => t.move(e.pointerId, e.clientX, e.clientY),
      onPointerUpCapture: end,
      onPointerCancelCapture: end,
    },
    allowsClick: () => t.allowsClick(),
    allowsContextMenu: () => t.allowsContextMenu(),
  };
}
