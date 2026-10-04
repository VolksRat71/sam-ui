// sam-ui (Apache-2.0). Keep a floating control within the visible viewport.
export function placePopover(anchor: {left: number; top: number; bottom: number}, width: number, height: number, viewport: {width: number; height: number}) {
  const margin = 8;
  const availableBelow = Math.max(0, viewport.height - anchor.bottom - margin * 2);
  const availableAbove = Math.max(0, anchor.top - margin * 2);
  const above = availableBelow < height && availableAbove > availableBelow;
  const maxHeight = Math.max(0, above ? availableAbove : availableBelow);
  const fittedWidth = Math.min(width, Math.max(0, viewport.width - margin * 2));
  return {
    left: Math.max(margin, Math.min(anchor.left, viewport.width - fittedWidth - margin)),
    top: above ? Math.max(margin, anchor.top - margin - Math.min(height, maxHeight)) : anchor.bottom + margin,
    width: fittedWidth,
    maxHeight,
  };
}
