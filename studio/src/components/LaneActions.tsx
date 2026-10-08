// sam-ui (Apache-2.0). Presentation only; the session owns absent ranges.
import {OverflowMenuHorizontal} from '@carbon/icons-react';
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {placePopover} from '~/lib/popover';

type Props = {
  name: string;
  disabled: boolean;
  onAbsent: () => void;
};

export default function LaneActions({name, disabled, onAbsent}: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({left: 8, top: 8, width: 288, maxHeight: 100});
  // focus goes back to what opened the menu (the layer, on Shift F10), else the trigger, which is no Tab stop
  const opener = useRef<HTMLElement | null>(null);
  const close = () => { setOpen(false); (opener.current?.isConnected ? opener.current : trigger.current)?.focus({preventScroll: true}); };
  useLayoutEffect(() => {
    if (!open) return;
    const from = document.activeElement;
    opener.current = from instanceof HTMLElement && from !== trigger.current && from !== document.body ? from : null;
    const place = () => {
      if (trigger.current && menu.current) setPosition(placePopover(trigger.current.getBoundingClientRect(), 288, menu.current.scrollHeight + 2, {width: innerWidth, height: innerHeight}));
    };
    place();
    menu.current?.querySelector('button')?.focus({preventScroll: true});
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <span className="lane-actions" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <button ref={trigger} type="button" tabIndex={-1} className="button subtle compact" aria-label={`Actions for ${name}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
      onClick={() => setOpen(v => !v)} onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}>
      <OverflowMenuHorizontal size={16} />
    </button>
    {open && createPortal(<div ref={menu} className="lane-action-menu" role="menu" aria-label={`Actions for ${name}`} style={position}
      onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        if (e.key === 'Tab') close();
      }}>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => { onAbsent(); close(); }}>Mark absent until it comes back</button>
    </div>, document.body)}
  </span>;
}
