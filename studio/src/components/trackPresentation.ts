// sam-ui (Apache-2.0). Display vocabulary only; no tracking state is changed here.
export function trackPresentation(state: string, running = false) {
  if (state === 'refining') return {label: 'Refining', detail: 'Updating this frame’s matte.', kind: 'updating'};
  if (running || state === 'tracking') return {label: 'Tracking', detail: 'Updating the matte across frames.', kind: 'updating'};
  if (state === 'stale') return {label: 'Changed', detail: 'The cached matte is from an earlier edit. Track again to refresh it.', kind: 'changed'};
  if (state === 'tracked') return {label: 'Tracked', detail: 'The cached matte matches the current edits.', kind: 'ready'};
  return {label: 'Untracked', detail: 'Add a keyframe, then track this layer.', kind: 'empty'};
}
