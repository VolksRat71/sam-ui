import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import RefineDetail from '../src/components/RefineDetail';
import {initialState, fromServer} from '../src/state/objects';
import {DataArray, encode} from '../src/meta/jscocotools/mask';
import '../src/styles.css'; import '../src/suite.css';
const calls: unknown[][] = []; Object.assign(window, {calls});
const pixels = new Uint8Array(320 * 180); pixels[160 * 180 + 90] = 1;
const base = encode(new DataArray(pixels, [180, 320, 1]))[0];
const source = document.createElement('canvas'); source.width = 320; source.height = 180;
const ctx = source.getContext('2d')!; ctx.fillStyle = '#323236'; ctx.fillRect(0,0,320,180); ctx.fillStyle = '#aab3bc'; ctx.fillRect(130,40,60,100);
export default function Fixture() {
  const [unavailable, setUnavailable] = useState(false); const [removed, setRemoved] = useState(false);
  const [frame, setFrame] = useState(0); const [engine, setEngine] = useState('sam2'); const [empty, setEmpty] = useState(false);
  const object = {...fromServer({objectId: 1, seeds: [], state: 'tracked'}), name: 'Synthetic coat'};
  const session = {backend: true, state: {...initialState, activeId: 1, objects: [object], engine}, status: 'ready', frame, busy: false,
    detailRequest: async (operation: string, args: Record<string, unknown>) => {
      calls.push([operation, args]);
      if (operation === 'detail_state') return {enabled: true, objects: {}};
      if (operation === 'remove_detail_crop') { setRemoved(true); return {removed: true}; }
      if (operation === 'detail_frame' && unavailable) return {revision: null, snapshot_revision: 'snapshot1', base: null, details: removed ? [] : [{id: 'a'.repeat(64)}]};
      if (operation === 'detail_frame') return {revision: 'r1', snapshot_revision: 'snapshot1', width: 320, height: 180, image: source.toDataURL(), base, combined: base, details: []};
      if (operation === 'preview_detail_crop') return {preview_id: 'p1', revision: 'r1', added_pixels: empty ? 0 : 7, combined: base};
      return {revision: 'r2'};
    }};
  return <><div style={{padding: '130px 12px 12px', display: 'flex', flexWrap: 'wrap', gap: 8}}><button onClick={() => setFrame(f => f + 1)}>Next frame</button><button onClick={() => setEngine(e => e === 'sam2' ? 'browser-sam2' : 'sam2')}>Browser engine</button><button onClick={() => setEmpty(e => !e)}>Empty result</button><button onClick={() => setUnavailable(true)}>Unavailable base</button></div><RefineDetail session={session as never} /></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
