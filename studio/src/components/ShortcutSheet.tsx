// sam-ui (Apache-2.0). New file, not from SAM 2.
import {useEffect, useRef} from 'react';

const shortcuts = [
  ['Space', 'Play or pause'],
  ['Shift / Ctrl / Cmd + wheel', 'Zoom the viewer at the pointer'],
  ['Wheel · Alt-drag · Middle-drag', 'Pan the zoomed viewer'],
  ['Left / Right', 'Previous or next frame'],
  ['O / Shift O', 'Next or previous layer'],
  ['Up / Down · Home / End', 'Select layers while the layer list has focus'],
  ['Enter', 'Open selected layer controls from the layer list'],
  ['Alt Up / Alt Down', 'Reorder the focused layer or group'],
  ['K / Shift K', 'Next or previous keyframe while a layer or its frame lane has focus'],
  ['Shift Left / Shift Right', 'Select a frame span while a layer or its frame lane has focus'],
  ['Shift F10', 'Open the focused layer’s lane actions'],
  ['. / ,', 'Next or previous review marker, in priority order'],
  ['Y', 'Mark the current review stop as looking right'],
  ['F', 'Toggle a correction marker on the current frame'],
  ['] / [', 'Next or previous unconfirmed span'],
  ['P / A / R', 'Mark an unconfirmed span present, absent, or reject it'],
  ['Cmd/Ctrl Z · Shift Cmd/Ctrl Z', 'Undo or redo the selected layer’s clicks and ranges'],
  ['Escape', 'Clear a span selection or close a dialog'],
  ['?', 'Open this shortcut sheet'],
];

export default function ShortcutSheet({onClose}: {onClose: () => void}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => previous?.focus();
  }, []);
  return <dialog ref={ref} className="shortcut-sheet" aria-labelledby="shortcut-title" onCancel={e => { e.preventDefault(); onClose(); }}>
    <header><h2 id="shortcut-title">Keyboard shortcuts</h2><button className="button" onClick={onClose} autoFocus>Close</button></header>
    <p>Shortcuts pause while you type in a field. Undo applies to the selected layer.</p>
    <dl>{shortcuts.map(([keys, description]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{description}</dd></div>)}</dl>
  </dialog>;
}
