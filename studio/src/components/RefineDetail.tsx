// Experimental, additive working-copy detail. No crop clicks reach the session prompts.
import {useEffect, useRef, useState} from 'react';
import {decode, type RLEObject} from '@/jscocotools/mask';
import {detailAvailable} from '~/state/detail';
import {objectName} from '~/state/fileNames';
import type {DetailRecord, DetailState} from '~/state/detail';
import type {StudioSessionApi} from '~/workspace/useStudioSession';

type Frame = {revision: string; snapshot_revision: string; unavailable?: string; width: number; height: number; image: string; base: RLEObject | null; combined: RLEObject; details: DetailRecord[]};
type Result = {preview_id: string; revision: string; added_pixels: number; combined: RLEObject};
type Rect = [number, number, number, number];
type Point = [number, number, number];

export default function RefineDetail({session}: {session: StudioSessionApi}) {
  const available = detailAvailable(session.backend, session.state.engine);
  const request = useRef(session.detailRequest); request.current = session.detailRequest;
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [rect, setRect] = useState<Rect>([0, 0, 128, 128]);
  const [points, setPoints] = useState<Point[]>([]);
  const [size, setSize] = useState(256);
  const [label, setLabel] = useState(1);
  const [view, setView] = useState('after');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [cursor, setCursor] = useState([.5, .5]);
  const token = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const crop = useRef<HTMLCanvasElement>(null);
  const drag = useRef<[number, number] | null>(null);
  const object = session.state.objects.find(o => o.id === session.state.activeId);
  useEffect(() => {
    let cancelled = false;
    setEnabled(false);
    if (available && session.status === 'ready') void request.current('detail_state').then(r => { if (!cancelled) setEnabled((r as DetailState).enabled); }).catch(() => { if (!cancelled) setEnabled(false); });
    return () => { cancelled = true; };
  }, [available, session.status, session.state.engine]);
  useEffect(() => {
    token.current++; setOpen(false); setFrame(null); setResult(null); setPoints([]); setBusy(false);
  }, [session.frame, session.state.activeId, session.state.engine]);
  useEffect(() => () => { token.current++; }, []);
  useEffect(() => {
    const canvas = crop.current;
    if (!canvas || !frame?.base) return;
    const image = new Image(); let cancelled = false;
    image.onload = () => {
      if (cancelled) return;
      const [x0, y0, x1, y1] = rect; canvas.width = x1 - x0; canvas.height = y1 - y0;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0, 0, 0, canvas.width, canvas.height);
      const mask = view === 'before' ? frame.combined : result?.combined ?? frame.combined;
      const decoded = decode([mask]).data;
      const old = view === 'added' ? decode([frame.combined]).data : null;
      ctx.fillStyle = object?.color ?? '#2d8ceb'; ctx.globalAlpha = .45;
      for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) if (decoded[x * frame.height + y] && !old?.[x * frame.height + y]) ctx.fillRect(x - x0, y - y0, 1, 1);
      ctx.globalAlpha = 1;
      points.forEach(([x, y, l]) => { ctx.beginPath(); ctx.arc(x * canvas.width, y * canvas.height, 3, 0, Math.PI * 2); ctx.fillStyle = l === 1 ? '#ffffff' : '#e8b339'; ctx.fill(); ctx.strokeStyle = '#1b1b1c'; ctx.stroke(); });
    };
    image.src = frame.image;
    return () => { cancelled = true; };
  }, [frame, rect, points, result, view, object?.color]);
  if (!available || !enabled) return null;
  const close = () => {
    if (saving) return;
    if (result && !window.confirm('Discard this detail preview?')) return;
    token.current++; setOpen(false); setBusy(false); setResult(null); trigger.current?.focus();
  };
  const args = {object_id: session.state.activeId, frame_index: session.frame};
  const begin = async () => {
    const mine = ++token.current; setOpen(true); setBusy(true); setNote('Loading working-copy frame…'); setResult(null); setFrame(null);
    try {
      const f = await request.current('detail_frame', args) as Frame;
      if (mine !== token.current) return;
      setFrame(f); if (f.base) setRect([0, 0, Math.min(size, f.width), Math.min(size, f.height)]); setPoints([]); setNote(f.base ? 'Start with a clean base mask. Detail clicks stay inside this crop.' : 'The base is unavailable on this frame. Saved details can still be removed.');
    } catch (e) { if (mine === token.current) setNote(e instanceof Error ? e.message : String(e)); }
    finally { if (mine === token.current) setBusy(false); }
  };
  const changeRect = (r: Rect) => {
    if (!frame || r.some(n => !Number.isInteger(n)) || r[0] < 0 || r[1] < 0 || r[2] > frame.width || r[3] > frame.height || r[2] <= r[0] || r[3] <= r[1] || r[2] - r[0] > 256 || r[3] - r[1] > 256) return;
    setRect(r); setPoints([]); setResult(null); setNote('Crop changed. Place a new Include point.');
  };
  const point = (x: number, y: number) => { setPoints(p => [...p.slice(-63), [x, y, label]]); setResult(null); };
  const refine = async () => {
    if (!frame) return;
    const mine = ++token.current; setBusy(true); setNote('Refining this frame with SAM 2.1…');
    try {
      const r = await request.current('preview_detail_crop', {...args, correction_revision: frame.revision, crop_rect: rect, crop_points: points, request_id: crypto.randomUUID()}) as Result;
      if (mine === token.current) { setResult(r); setNote(r.added_pixels ? `${r.added_pixels} added pixels. This frame only.` : 'No new detail found. Try a smaller crop or adjust your clicks.'); }
    } catch (e) { if (mine === token.current) setNote(e instanceof Error ? e.message : String(e)); }
    finally { if (mine === token.current) setBusy(false); }
  };
  const apply = async () => {
    if (!result) return;
    const mine = ++token.current; setBusy(true); setSaving(true);
    try {
      await request.current('apply_detail_crop', {preview_id: result.preview_id, expected_correction_revision: result.revision});
      if (mine === token.current) { setResult(null); setOpen(false); trigger.current?.focus(); }
    } catch (e) { if (mine === token.current) setNote(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); if (mine === token.current) setBusy(false); }
  };
  return <div className="detail-tool" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape' && open) { e.preventDefault(); close(); } }}>
    <details className="detail-entry"><summary>Experimental</summary><button ref={trigger} className="button compact" disabled={!object || session.busy} onClick={() => void begin()}>Refine Detail</button></details>
    {open && <section className="detail-panel" aria-label="Refine Detail">
      <strong>Refine Detail · {object && objectName(object)} · Frame {session.frame + 1}</strong>
      <span className="muted">Working copy · SAM 2.1 detail pass · This frame only</span>
      <p role="status">{note}</p>
      {frame?.base && <>
        <div className="detail-overview" onPointerDown={e => { if (busy) return; const b = e.currentTarget.getBoundingClientRect(); drag.current = [(e.clientX - b.left) / b.width * frame.width, (e.clientY - b.top) / b.height * frame.height]; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerUp={e => { if (!drag.current || busy) return; const b = e.currentTarget.getBoundingClientRect(); const [x, y] = drag.current; drag.current = null; const ex = Math.max(0, Math.min(frame.width, (e.clientX - b.left) / b.width * frame.width)), ey = Math.max(0, Math.min(frame.height, (e.clientY - b.top) / b.height * frame.height));
            if (Math.abs(ex - x) + Math.abs(ey - y) > 8) { const x0 = Math.max(0, Math.floor(Math.min(x, ex))), y0 = Math.max(0, Math.floor(Math.min(y, ey))); changeRect([x0, y0, Math.min(frame.width, x0 + 256, Math.ceil(Math.max(x, ex))), Math.min(frame.height, y0 + 256, Math.ceil(Math.max(y, ey)))]); }
            else { const w = Math.min(size, frame.width), h = Math.min(size, frame.height), x0 = Math.max(0, Math.min(frame.width - w, Math.round(x - w / 2))), y0 = Math.max(0, Math.min(frame.height - h, Math.round(y - h / 2))); changeRect([x0, y0, x0 + w, y0 + h]); setPoints([[(x - x0) / w, (y - y0) / h, 1]]); }
          }} onPointerCancel={() => { drag.current = null; }}>
          <img src={frame.image} alt="Working-copy frame: click a detail or drag a crop box" draggable={false} />
          <span style={{left: `${rect[0] / frame.width * 100}%`, top: `${rect[1] / frame.height * 100}%`, width: `${(rect[2] - rect[0]) / frame.width * 100}%`, height: `${(rect[3] - rect[1]) / frame.height * 100}%`}} />
        </div>
        <label>Crop size <select value={size} disabled={busy} onChange={e => { const n = Number(e.target.value); setSize(n); changeRect([rect[0], rect[1], Math.min(frame.width, rect[0] + n), Math.min(frame.height, rect[1] + n)]); }}><option value={128}>128 px</option><option value={256}>256 px</option></select></label>
        <div className="detail-bounds">{['Left', 'Top', 'Right', 'Bottom'].map((name, i) => <label key={name}>{name}<input aria-label={`Crop ${name.toLowerCase()}`} type="number" value={rect[i]} min={0} disabled={busy} onChange={e => { const next: Rect = [...rect]; next[i] = Number(e.target.value); changeRect(next); }} /></label>)}</div>
        <div className="detail-controls"><label>Point tool <select value={label} disabled={busy} onChange={e => setLabel(Number(e.target.value))}><option value={1}>Include</option><option value={0}>Exclude</option></select></label><label>Compare <select value={view} onChange={e => setView(e.target.value)}><option value="before">Before</option><option value="after">After</option><option value="added">Added pixels</option></select></label></div>
        <canvas ref={crop} className="detail-crop" tabIndex={0} role="img" aria-label="Crop points. Arrow keys move the point cursor; Enter places a point."
          onClick={e => { if (busy) return; const b = e.currentTarget.getBoundingClientRect(); point((e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height); }}
          onKeyDown={e => { if (busy) return; if (e.key === 'Enter') { e.preventDefault(); point(cursor[0], cursor[1]); } else if (e.key.startsWith('Arrow')) { e.preventDefault(); setCursor(([x,y]) => [Math.max(0, Math.min(1, x + (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0) / (rect[2] - rect[0]))), Math.max(0, Math.min(1, y + (e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0) / (rect[3] - rect[1])))]); } }} />
        <span className="muted">Point cursor: {Math.round(cursor[0] * (rect[2] - rect[0]))}, {Math.round(cursor[1] * (rect[3] - rect[1]))} px</span>
        <button className="button subtle" disabled={busy || !points.length} onClick={() => { setPoints([]); setResult(null); }}>Clear crop points</button>

      </>}
        {frame?.details.map((d, i) => <button key={d.id} className="button subtle" disabled={busy} onClick={async () => { setBusy(true); try { await request.current('remove_detail_crop', {...args, detail_id: d.id, expected_correction_revision: frame.snapshot_revision}); await begin(); } catch (e) { setNote(String(e)); setBusy(false); } }}>Remove detail {i + 1}</button>)}
      <div className="detail-controls"><button className="button" disabled={busy || !frame?.base || !points.some(p => p[2] === 1)} onClick={() => void refine()}>Refine</button><button className="button primary" disabled={busy || !result?.added_pixels} onClick={() => void apply()}>Apply detail</button><button className="button" disabled={saving} onClick={close}>Cancel</button></div>
    </section>}
  </div>;
}
