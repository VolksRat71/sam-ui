// sam-ui (Apache-2.0). Real decoder samples; no static review footage is loaded here.
import {useEffect, useRef, useState} from 'react';
import type {StudioSessionApi} from '../../workspace/useStudioSession';
import LinedInspectionMarks from './LinedInspectionMarks';
import {Filmstrip, FilmstripPlayhead, FrameThumbnail, Sprockets} from './viewer';

export default function LiveFilmstrip({session}: {session: StudioSessionApi}) {
  const {bridge, meta} = session;
  const canvases = useRef<Array<HTMLCanvasElement | null>>([]);
  const [error, setError] = useState<string | null>(null);
  const count = Math.min(7, meta.numFrames);
  const frames = Array.from({length: count}, (_, i) => count <= 1 ? 0 : Math.round(i * (meta.numFrames - 1) / (count - 1)));
  useEffect(() => {
    if (bridge == null || !meta.decoded || count < 1 || meta.height <= 0) return;
    let cancelled = false;
    const height = 84;
    const cellWidth = height * meta.width / meta.height;
    setError(null);
    void bridge.createFilmstrip(Math.max(1, Math.floor(cellWidth * count)), height).then(bitmap => {
      try {
        if (cancelled) return;
        canvases.current.forEach((canvas, i) => {
          if (canvas == null) return;
          const width = Math.min(cellWidth, bitmap.width - cellWidth * i);
          canvas.width = Math.round(cellWidth);
          canvas.height = height;
          canvas.getContext('2d')?.drawImage(bitmap, cellWidth * i, 0, width, height, 0, 0, canvas.width, height);
        });
      } finally {bitmap.close();}
    }).catch(error => {if (!cancelled) setError(`Could not decode filmstrip: ${error instanceof Error ? error.message : String(error)}`);});
    return () => {cancelled = true;};
  }, [bridge, meta.decoded, meta.width, meta.height, count]);
  return <Filmstrip id="filmstrip" numFrames={meta.numFrames} frameIndex={session.frame} onSeek={session.seek}>
    <Sprockets id="filmstrip-upper-sprockets" />
    <div className="lined-film-frames">{frames.map((frame, i) => <div className="lined-film-cell" key={frame}>
      <FrameThumbnail id={`filmstrip-frame-${214 + i}`}><canvas ref={canvas => {canvases.current[i] = canvas;}} aria-label={`Real footage sample, frame ${frame + 1}`} /></FrameThumbnail>
      <span id={`filmstrip-label-${214 + i}`} className="ls-frame-number">{frame + 1}</span>
    </div>)}</div>
    <Sprockets id="filmstrip-lower-sprockets" />
    <FilmstripPlayhead id="filmstrip-current-frame" frameIndex={session.frame} numFrames={meta.numFrames} />
    <LinedInspectionMarks session={session} />
    {error != null && <span className="lined-film-error" role="alert">{error}</span>}
  </Filmstrip>;
}
