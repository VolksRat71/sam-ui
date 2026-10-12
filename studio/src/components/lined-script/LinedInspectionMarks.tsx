// sam-ui (Apache-2.0). Presentation only; retain the existing audit spans and jump behavior.
import person from '../../assets/lined-script/inspection-person.png';
import ball from '../../assets/lined-script/inspection-ball.png';
import tree from '../../assets/lined-script/inspection-tree.png';
import {objectName} from '../../state/fileNames';
import type {StudioSessionApi} from '../../workspace/useStudioSession';
import {reviewSpans} from '../reviewPresentation';
import {InspectionMark} from './timeline';

const marks = [person, ball, tree];

export default function LinedInspectionMarks({session, objectId}: {session: StudioSessionApi; objectId?: number}) {
  const n = session.meta.numFrames;
  return <>{reviewSpans(session.review?.queue ?? []).filter(span => objectId == null || span.objectId === objectId).map(span => {
    const layer = session.ordered.findIndex(o => o.id === span.objectId);
    const name = objectName(session.state.objects.find(o => o.id === span.objectId) ?? {id: span.objectId});
    const left = n <= 1 ? 0 : span.peak.frame / (n - 1) * 100;
    return <InspectionMark
      key={`${span.objectId}-${span.start}-${span.reviewed}`}
      src={marks[Math.max(0, layer) % marks.length]}
      layerName={name}
      frameIndex={span.peak.frame}
      data-review-object-id={span.objectId}
      style={{position: 'absolute', left: `clamp(0px, calc(${left}% - 12px), calc(100% - 24px))`, top: 0, width: 24, height: 19, opacity: span.reviewed ? .5 : 1}}
      onClick={event => {event.stopPropagation(); session.goToStop(span.peak);}}
    />;
  })}</>;
}
