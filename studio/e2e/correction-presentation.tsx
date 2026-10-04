// Isolated presentation fixture. No worker, API, user media or model execution.
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import Timeline from '../src/components/Timeline';
import CorrectionNudge from '../src/components/CorrectionNudge';
import {fromServer, initialState} from '../src/state/objects';
import '../src/styles.css';
import '../src/responsive.css';
import '../src/suite.css';
const calls: unknown[][] = [];
Object.assign(window, {calls});
export default function Fixture() {
  const [frame, setFrame] = useState(12);
  const [activeId, select] = useState<number | null>(1);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('nudge');
  const [sam3, setSam3] = useState(true);
  const objects = Array.from({length: 16}, (_, i) => ({...fromServer({objectId: i + 1, seeds: [], state: i === 1 ? 'stale' : 'ready'}), name: `Layer ${i + 1}`}));
  const state = {...initialState, activeId, objects, layout: {order: objects.map(o => o.id), groups: [{id: 'group', name: 'Wardrobe', color: '#3fd0ff', members: [1, 2, 3, 4], hidden: false, collapsed: false}]}};
  const record = (method: string) => (...args: unknown[]) => { calls.push([method, ...args]); };
  const session = new Proxy({state, frame, busy, status: 'ready', canAdd: true, ordered: objects,
    meta: {numFrames: 90, fps: 24, width: 1280, height: 720, decoded: false}, bridge: null,
    flags: {}, tracklets: new Map(), disagreement: new Map(), review: null, currentStop: null,
    seek: setFrame, selectObject: (id: number) => { calls.push(['select', id]); select(id); },
    markAbsentUntilNextSeed: record('absent'), objectColors: {}, textSupport: {ok: false, why: 'Fixture'},
  }, {get: (target, key) => key in target ? target[key] : record(String(key))});
  return <>
    <div style={{padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap'}}>
      <button onClick={() => setFrame(37)}>Frame 38</button><button onClick={() => setBusy(v => !v)}>Toggle busy</button>
      <button onClick={() => setMode('hint')}>Hint</button><button onClick={() => setMode('none')}>No message</button><button onClick={() => setMode('nudge')}>Nudge</button><button onClick={() => setSam3(v => !v)}>Toggle SAM 3</button>
    </div>
    <div style={{position: 'relative', height: 160}} onClick={record('canvas')}>
      <CorrectionNudge nudge={mode === 'nudge' ? {objectId: 1, frame, engine: 'sam2'} : null} hint={mode === 'hint' ? {kind: 'gone', objectId: 1, frame} : null} sam3Available={sam3} onTrim={() => record('trim')()} onSam3={() => record('sam3')()} onGone={() => record('gone')()} />
    </div>
    <Timeline session={session as never} />
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
