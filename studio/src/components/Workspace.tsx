// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// One video's editor: a top bar with the job controls, the preview on the
// left, collapsible Media, Objects and Effects sections on the right, and the timeline
// along the bottom. Every divider drags; sizes are remembered per browser.
import {Close, Renew} from '@carbon/icons-react';
import {useEffect, useState, type ReactNode} from 'react';
import {Panel, PanelGroup, PanelResizeHandle} from 'react-resizable-panels';
import {panelStorage} from '~/lib/storage';
import {videoDisplayName} from '~/lib/uploadNames';
import {BROWSER_ENGINE, engineLabel} from '~/state/engines';
import {objectName} from '~/state/fileNames';
import {historyShortcut} from '~/state/history';
import {jobProgress} from '~/state/objects';
import useStudioSession, {type VideoItem} from '~/workspace/useStudioSession';
import AeExportModal from './AeExportModal';
import ConfirmModal from './ConfirmModal';
import {DemoBanner, DemoTag, UnsupportedNotice} from './DemoNotice';
import {pageNotice} from '~/state/notices';
import EnginePicker from './EnginePicker';
import EffectsSection from './EffectsSection';
import ExportMenu, {type ExportChoice} from './ExportMenu';
import ExportPanel from './ExportPanel';
import MaskExportModal from './MaskExportModal';
import ExportVideoModal from './ExportVideoModal';
import Preview, {type LabelMode} from './Preview';
import ReviewSection from './ReviewSection';
import Sidebar from './Sidebar';
import Timeline from './Timeline';
import UpdateBanner from './UpdateBanner';

type Props = {
  video: VideoItem;
  renderMedia: (locked: boolean) => ReactNode;
};

export default function Workspace({video, renderMedia}: Props) {
  const session = useStudioSession(video);
  const {state, dirty, meta} = session;
  const [mode, setMode] = useState<LabelMode>('positive');
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const [exporting, setExporting] = useState<ExportChoice | null>(null);
  const videoName = videoDisplayName(video.path);
  const jobs = state.jobs;
  // no backend, or none of its engines can run: the browser engine is all there is
  const browserOnly = session.engines.length > 0 && session.engines.every(e => e.local || !e.available);
  const notice = pageNotice({backend: session.backend, webgpu: session.webgpu, browserOnly});
  const nameOf = (id: number) => objectName(state.objects.find(o => o.id === id) ?? {id});
  const n = meta.numFrames;

  // keyboard: space plays, arrows step, F flags the frame, Cmd-Z / Shift-Cmd-Z undo
  // and redo the selected object's clicks, . and , step through the review
  // queue and Y says its stop looks right (none of them while typing in a field;
  // the review keys also work with a button focused, as after clicking a stop)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = historyShortcut(e);
      if (step != null) {
        e.preventDefault();
        if (!e.repeat) {
          session.stepSeeds(step);
        }
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target != null && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        return;
      }
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (plain && document.querySelector('.modal-backdrop') == null) {
        if (e.key === '.' || e.key === ',') {
          e.preventDefault();
          session.stepReview(e.key === '.' ? 1 : -1);
          return;
        }
        if ((e.key === 'y' || e.key === 'Y') && session.currentStop != null && !e.repeat) {
          e.preventDefault();
          session.markReviewed(session.currentStop, true, true);
          return;
        }
      }
      if (target != null && target.tagName === 'BUTTON') {
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        session.togglePlay();
      } else if (e.key === 'ArrowLeft') {
        session.seek(session.frame - 1);
      } else if (e.key === 'ArrowRight') {
        session.seek(session.frame + 1);
      } else if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        session.toggleFlag();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  const trackLabel =
    dirty.length === 0
      ? 'Nothing to track'
      : `Track ${dirty.length} ${dirty.length === 1 ? 'object' : 'objects'}`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          sam-ui <span className="muted">studio</span>
        </div>
        <div className="topbar-status">
          {jobs.map(job => (
            <span key={job.key} className="job-chip">
              <span className="spinner small" />
              {job.canceling ? 'Cancelling' : 'Tracking'} {job.ids.map(nameOf).join(', ')}
              <span className="engine-tag">{engineLabel(job.engine)}</span>
              {job.bounded.length > 0 && (
                <span
                  className="muted"
                  title={`Re-tracking ${job.bounded.map(nameOf).join(', ')} only around the corrections, keeping the cached frames beyond`}>
                  near corrections
                </span>
              )}
              {job.frames === 0 && session.engines.find(e => e.name === job.engine)?.loading && (
                <span className="muted">loading the model…</span>
              )}
              <span className="job-progress">
                <span style={{width: `${Math.round(jobProgress(job, n).fraction * 100)}%`}} />
              </span>
              <span className="muted">
                {jobProgress(job, n).done}
                {jobProgress(job, n).total != null ? `/${jobProgress(job, n).total}` : ''}
              </span>
              <button
                className="chip-close"
                onClick={() => session.cancelTrack(job.key)}
                disabled={job.canceling || job.jobId == null}
                title="Cancel this job">
                <Close size={14} />
              </button>
            </span>
          ))}
          {session.foreignJobs.map(job => (
            <span key={job.jobId} className="job-chip foreign" title="A job started in another tab or session">
              <span className="spinner small" />
              Elsewhere: {job.objects.map(nameOf).join(', ')}
              <span className="muted">
                {job.framesDone}
                {job.nFrames != null ? `/${job.nFrames}` : ''}
              </span>
            </span>
          ))}
          {jobs.length === 0 && session.foreignJobs.length === 0 && (
            session.repainting ? (
              <span>
                <span className="spinner small" /> Loading cached tracks…
              </span>
            ) : session.pending > 0 ? (
              <span>
                <span className="spinner small" /> Updating…
              </span>
            ) : state.notice != null ? (
              <span className="error">Last track did not finish: {state.notice}</span>
            ) : null
          )}
        </div>
        <div className="topbar-actions">
          {jobs.length > 1 && (
            <button className="button" onClick={() => session.cancelTrack()} title="Cancel every job of this session">
              <Close size={16} /> Cancel all
            </button>
          )}
          {state.engine === BROWSER_ENGINE && !session.noEngine && <DemoTag />}
          <ExportMenu session={session} videoPath={video.path} onChoose={setExporting} />
          <button
            className="button subtle"
            onClick={() => setConfirmStartOver(true)}
            disabled={session.busy || jobs.length > 0 || state.objects.length === 0}
            title="Remove every object and cached track for this video">
            <Renew size={16} /> Start over
          </button>
        </div>
      </header>

      {notice === 'unsupported' ? <UnsupportedNotice /> : <DemoBanner show={session.status === 'ready' && notice === 'demo'} />}
      <UpdateBanner />

      {session.warning != null && (
        <div className="toast" role="status">
          <span>{session.warning}</span>
          <button className="link-button" onClick={session.dismissWarning}>
            Dismiss
          </button>
        </div>
      )}

      <PanelGroup direction="vertical" autoSaveId="sam-ui-suite:rows" storage={panelStorage} className="main">
        <Panel id="top" order={0} defaultSize={55} minSize={25}>
          <PanelGroup direction="horizontal" autoSaveId="sam-ui-studio:cols" storage={panelStorage}>
            <Panel id="preview" order={0} defaultSize={65} minSize={30}>
              <Preview session={session} mode={mode} onModeChange={setMode} />
            </Panel>
            <PanelResizeHandle className="resize-handle vertical" />
            <Panel id="sidebar" order={1} defaultSize={35} minSize={24} collapsible collapsedSize={0}>
              <Sidebar
                sections={[
                  {
                    id: 'review',
                    title: 'Review',
                    badge:
                      session.review != null && session.review.queue.length > 0
                        ? `${session.review.queue.filter(e => !e.reviewed).length} to check / ${session.review.queue.length}`
                        : undefined,
                    content: <ReviewSection session={session} />,
                  },
                  {
                    id: 'effects',
                    title: 'Effects',
                    content: (
                      <EffectsSection session={session} />
                    ),
                  },
                  {id: 'media', title: 'Media', content: renderMedia(jobs.length > 0)},
                ]}
              />
            </Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle className="resize-handle horizontal" />
        <Panel id="timeline" order={1} defaultSize={45} minSize={30}>
          <Timeline session={session} actions={<>
          <EnginePicker session={session} />
          <div className="track-action">
            <button
              className="button cta"
              onClick={session.track}
              disabled={dirty.length === 0 || session.busy}
              title="Track the objects that are untracked or stale; running jobs keep theirs">
              {trackLabel}
            </button>
          </div>
          </>} />
        </Panel>
      </PanelGroup>

      {exporting === 'effects' && (
        <ExportVideoModal session={session} videoName={videoName} onClose={() => setExporting(null)} />
      )}
      {(exporting === 'videos' || exporting === 'vectors') && (
        <MaskExportModal session={session} kind={exporting} videoPath={videoName} onClose={() => setExporting(null)} />
      )}
      {exporting === 'ae' && <AeExportModal session={session} video={video} onClose={() => setExporting(null)} />}
      {exporting === 'folder' && (
        <ExportPanel
          session={session}
          videoName={videoName}
          mode={session.backend && state.engine !== BROWSER_ENGINE ? 'server' : 'zip'}
          onClose={() => setExporting(null)}
        />
      )}

      {confirmStartOver && (
        <ConfirmModal
          title="Start over?"
          confirmLabel="Start over"
          danger
          onCancel={() => setConfirmStartOver(false)}
          onConfirm={() => {
            setConfirmStartOver(false);
            session.startOver();
          }}>
          This removes every object on this video, with its clicks and its cached track. It
          cannot be undone.
        </ConfirmModal>
      )}
    </div>
  );
}
