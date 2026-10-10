// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The topbar's Agent chip (issue #73): it appears once an agent has changed
// the open video, names the latest change with a Go to, and after a quiet
// spell counts the changes instead. Its list holds the last 20, each with Go
// to; undo stays studio's own (Cmd-Z on a layer steps back its last change,
// an agent's included). Nothing here accepts or rejects: agent changes are
// already applied and saved.
import {Bot} from '@carbon/icons-react';
import {useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import {placePopover} from '~/lib/popover';
import {ACTIVITY_LIMIT, type AgentEntry, ageLabel, describeEntry} from '~/state/agentActivity';
import {objectName} from '~/state/fileNames';
import type {StudioSessionApi} from '~/workspace/useStudioSession';

/** How long the chip names the latest change before it only counts them. */
const FRESH_MS = 30_000;
const LIST_WIDTH = 380;

type Props = {session: StudioSessionApi};

export default function AgentActivity({session}: Props) {
  const {agentActivity: entries, state, goToAgentChange} = session;
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({left: 8, top: 8, width: LIST_WIDTH, maxHeight: 400});
  const latest = entries[0];

  // the chip goes quiet FRESH_MS after the latest change; the open list's ages tick
  useEffect(() => {
    if (latest == null) return;
    setNow(Date.now());
    const left = latest.change.at + FRESH_MS - Date.now();
    const quiet = left > 0 ? setTimeout(() => setNow(Date.now()), left + 50) : undefined;
    const tick = open ? setInterval(() => setNow(Date.now()), 10_000) : undefined;
    return () => {
      clearTimeout(quiet);
      clearInterval(tick);
    };
  }, [latest, open]);

  useLayoutEffect(() => {
    if (!open || root.current == null || list.current == null) return;
    const position = () => {
      if (root.current == null || list.current == null) return;
      const next = placePopover(root.current.getBoundingClientRect(), LIST_WIDTH, list.current.scrollHeight + 2, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      setPlacement(p => (p.left === next.left && p.top === next.top && p.width === next.width && p.maxHeight === next.maxHeight ? p : next));
    };
    position();
    list.current.querySelector<HTMLButtonElement>('.agent-go')?.focus({preventScroll: true});
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open]);

  // closes on a click outside it, or Escape (focus back on the chip)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (latest == null) return null;

  const nameOf = (id: number) => objectName(state.objects.find(o => o.id === id) ?? {id});
  const fresh = now - latest.change.at < FRESH_MS;
  const count = `${entries.length}${entries.length === ACTIVITY_LIMIT ? '+' : ''} ${entries.length === 1 ? 'change' : 'changes'}`;
  const go = (e: AgentEntry) => {
    goToAgentChange(e);
    setOpen(false);
  };

  // arrows move between the rows' Go to buttons, as the engine picker's radios do
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('.agent-go') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next != null) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <span className="agent-chip" ref={root}>
      <button
        ref={toggle}
        type="button"
        className="agent-chip-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        title="What agents changed on this video">
        <Bot size={16} aria-hidden="true" />
        <span className="agent-chip-word">Agent</span>
        <span className="agent-chip-text">{fresh ? describeEntry(latest, nameOf) : count}</span>
      </button>
      {fresh && (
        <button type="button" className="link-button agent-chip-go" onClick={() => go(latest)}>
          Go to
        </button>
      )}
      {open &&
        createPortal(
          <div ref={list} className="agent-list floating" style={placement} role="dialog" aria-label="Agent changes" onKeyDown={onListKey}>
            <ol className="agent-rows">
              {entries.map(e => (
                <li key={e.id} className="agent-row">
                  <span className="agent-row-words">{describeEntry(e, nameOf)}</span>
                  <span className="agent-row-age">{ageLabel(now - e.change.at)}</span>
                  <button type="button" className="link-button agent-go" onClick={() => go(e)}>
                    Go to
                  </button>
                </li>
              ))}
            </ol>
            <p className="agent-list-note">Undo (Cmd-Z) on a layer steps back its last change, an agent&rsquo;s included.</p>
          </div>,
          document.body,
        )}
    </span>
  );
}

