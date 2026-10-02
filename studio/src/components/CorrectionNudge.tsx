// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// What the preview says about a frame's correction: on SAM 2, a nudge for a
// positive when the clicks were negatives only (nothing was sent); on SAM 3,
// which took them and emptied the frame, whether the object is gone for a
// while. Display only: the session owns the state and the handlers.
import type {Nudge} from '~/state/corrections';

type Props = {
  nudge: Nudge | null;
  hint: 'gone' | null;
  sam3Available: boolean;
  onTrim: () => void;
  onSam3: () => void;
};

// .stage-hint lets clicks through to the video; its buttons take them
const clickable = {pointerEvents: 'auto'} as const;

export default function CorrectionNudge({nudge, hint, sam3Available, onTrim, onSam3}: Props) {
  if (nudge != null) {
    return (
      <div className="stage-hint" role="status">
        SAM 2 needs a positive to keep something.
        <button type="button" style={clickable} onClick={onTrim}>Add a positive to trim</button>
        {sam3Available && <button type="button" style={clickable} onClick={onSam3}>Switch to SAM 3</button>}
      </div>
    );
  }
  if (hint === 'gone') {
    return (
      <div className="stage-hint" role="status">
        Gone for a while? Mark it absent until it comes back.
      </div>
    );
  }
  return null;
}
