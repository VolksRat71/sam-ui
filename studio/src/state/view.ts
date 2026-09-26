// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Preview zoom and pan. The fitted video box is scaled by `zoom` about its
// centre and moved by (x, y) screen pixels; zoom 1 is "fit", and the view
// never drifts off the video when zoomed back out.
export type View = {zoom: number; x: number; y: number};

export const FIT: View = {zoom: 1, x: 0, y: 0};
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

function clampPan(view: View, boxWidth: number, boxHeight: number): View {
  if (view.zoom <= MIN_ZOOM) {
    return FIT;
  }
  // keep some of the video on screen: at most half the scaled box off-centre
  const maxX = (boxWidth * view.zoom) / 2;
  const maxY = (boxHeight * view.zoom) / 2;
  return {
    zoom: view.zoom,
    x: Math.max(-maxX, Math.min(maxX, view.x)),
    y: Math.max(-maxY, Math.min(maxY, view.y)),
  };
}

/**
 * Zoom by `factor` keeping the point (px, py) still. The point is in screen
 * pixels relative to the centre of the unzoomed box.
 */
export function zoomAt(
  view: View,
  factor: number,
  px: number,
  py: number,
  boxWidth: number,
  boxHeight: number,
): View {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * factor));
  const k = zoom / view.zoom;
  return clampPan({zoom, x: px - (px - view.x) * k, y: py - (py - view.y) * k}, boxWidth, boxHeight);
}

export function panBy(view: View, dx: number, dy: number, boxWidth: number, boxHeight: number): View {
  return clampPan({...view, x: view.x + dx, y: view.y + dy}, boxWidth, boxHeight);
}
