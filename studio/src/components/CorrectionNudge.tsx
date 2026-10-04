// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// What the preview says about a frame's correction: on SAM 2, a nudge for a
// positive when the clicks were negatives only (nothing was sent); on SAM 3,
// which took them and emptied the frame, whether the object is gone for a
// while. Either offers "Gone for a while?": absent until the object comes
// back. Display only: the session owns the state and the handlers.
import type {Hint, Nudge} from '~/state/corrections';

type Props = {
  nudge: Nudge | null;
  hint: Hint | null;
  sam3Available: boolean;
  onTrim: () => void;
  onSam3: () => void;
  /** Absent from the frame until the object's next click (the session's markGone). */
  onGone: () => void;
};

// .stage-hint lets clicks through to the video; its buttons take them
const clickable = {pointerEvents: 'auto'} as const;

export default function CorrectionNudge({nudge, hint, sam3Available, onTrim, onSam3, onGone}: Props) {
  if (nudge != null) {
    return (
      <div className="stage-hint correction-nudge" role="status" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
        SAM 2 needs a positive to keep something.
        <button type="button" className="button compact" style={clickable} onClick={onTrim}>Add a positive to trim</button>
        {sam3Available && <button type="button" className="button compact" style={clickable} onClick={onSam3}>Switch to SAM 3</button>}
        <button type="button" className="button compact" style={clickable} onClick={onGone}>Gone for a while?</button>
      </div>
    );
  }
  if (hint?.kind === 'gone') {
    return (
      <div className="stage-hint correction-nudge" role="status" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
        {/* the hint's own question is the action, the same button as the nudge's */}
        <button type="button" className="button compact" style={clickable} onClick={onGone}>Gone for a while?</button> Mark it absent until it comes back.
      </div>
    );
  }
  return null;
}
