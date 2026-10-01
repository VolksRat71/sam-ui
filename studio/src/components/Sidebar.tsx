// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The right-hand column: collapsible sections. With more than one open they
// share the column through a draggable divider; a closed section keeps only
// its header. Below the desktop width (lib/layout.ts) the column is a
// panel under the preview instead, and the sections are tabs.
import {ChevronDown, ChevronRight} from '@carbon/icons-react';
import {Fragment, useLayoutEffect, useState, type ReactNode} from 'react';
import {Panel, PanelGroup, PanelResizeHandle} from 'react-resizable-panels';
import {COMPACT_QUERY, useMediaQuery} from '~/lib/layout';
import {panelStorage, readJson, writeJson} from '~/lib/storage';

export type Section = {
  id: string;
  title: string;
  badge?: ReactNode;
  content: ReactNode;
};

const OPEN_KEY = 'sam-ui-studio:sections-open';
const TAB_KEY = 'sam-ui-studio:sections-tab';

/**
 * Pixel heights per section, header included. `min` is the least that is
 * still useful (Media: the upload control and a row of thumbnails), and the
 * divider stops there; `need` is what shows its first content whole (Objects:
 * two rows). A short column fills mins first, then needs in PRIORITY order,
 * and shares what is left by WEIGHT.
 */
const HEIGHTS: Record<string, {min: number; need: number}> = {
  media: {min: 160, need: 160},
  objects: {min: 150, need: 390},
  review: {min: 64, need: 140},
  effects: {min: 64, need: 150},
};
const FALLBACK_HEIGHTS = {min: 72, need: 140};
const PRIORITY = ['media', 'objects', 'review', 'effects'];
const WEIGHT: Record<string, number> = {media: 1, objects: 3, review: 1, effects: 1};
/** The divider between two open sections (.resize-handle.horizontal). */
const HANDLE_PX = 8;
/** Used when the column cannot be measured (tests, a hidden column). */
const FALLBACK_COLUMN_PX = 600;

const heights = (id: string) => HEIGHTS[id] ?? FALLBACK_HEIGHTS;

/** Each open section's starting and least size, as the percentages the panel group takes. */
function sectionSizes(ids: string[], columnPx: number): Record<string, {size: number; min: number}> {
  const room = Math.max(1, columnPx - HANDLE_PX * Math.max(0, ids.length - 1));
  const mins = ids.map(id => heights(id).min);
  const minTotal = mins.reduce((a, b) => a + b, 0);
  // a column too short for every minimum scales them all down together
  const scale = minTotal > room ? room / minTotal : 1;
  const px = new Map(ids.map((id, i) => [id, mins[i] * scale]));
  let left = room - minTotal * scale;
  for (const id of [...PRIORITY, ...ids.filter(x => !PRIORITY.includes(x))]) {
    if (!px.has(id) || left <= 0) {
      continue;
    }
    const more = Math.min(left, heights(id).need - px.get(id)!);
    px.set(id, px.get(id)! + more);
    left -= more;
  }
  const weights = ids.reduce((sum, id) => sum + (WEIGHT[id] ?? 1), 0);
  return Object.fromEntries(
    ids.map(id => {
      const size = px.get(id)! + (left * (WEIGHT[id] ?? 1)) / weights;
      return [id, {size: (size / room) * 100, min: ((heights(id).min * scale) / room) * 100}];
    }),
  );
}

/** The column's height in px, measured before paint and kept current; 0 when it cannot be measured. */
function useHeight(): [(el: HTMLDivElement | null) => void, number | null] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (el == null) {
      return;
    }
    setHeight(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, height];
}

function Header({section, open, onToggle}: {section: Section; open: boolean; onToggle: () => void}) {
  return (
    <button className="section-header" onClick={onToggle} aria-expanded={open}>
      {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      <span className="section-title">{section.title}</span>
      {section.badge != null && <span className="section-badge">{section.badge}</span>}
    </button>
  );
}

/**
 * The sections as tabs, one shown at a time. Every section stays mounted,
 * hidden when not shown, so switching tabs never loses an upload or a draft.
 */
function SectionTabs({sections}: {sections: Section[]}) {
  const [tab, setTab] = useState(() => readJson<string>(TAB_KEY, 'objects'));
  const current = sections.find(s => s.id === tab)?.id ?? sections[0]?.id;
  const choose = (id: string) => {
    setTab(id);
    writeJson(TAB_KEY, id);
  };
  return (
    <div className="sidebar tabbed">
      <div className="section-tabs" role="tablist" aria-label="Panels">
        {sections.map(s => (
          <button
            key={s.id}
            id={`tab-${s.id}`}
            role="tab"
            aria-selected={s.id === current}
            aria-controls={`tabpanel-${s.id}`}
            className={s.id === current ? 'section-tab selected' : 'section-tab'}
            onClick={() => choose(s.id)}>
            <span className="section-title">{s.title}</span>
            {s.badge != null && <span className="section-badge">{s.badge}</span>}
          </button>
        ))}
      </div>
      {sections.map(s => (
        <div
          key={s.id}
          id={`tabpanel-${s.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${s.id}`}
          className="section-body"
          hidden={s.id !== current}>
          {s.content}
        </div>
      ))}
    </div>
  );
}

export default function Sidebar({sections}: {sections: Section[]}) {
  const compact = useMediaQuery(COMPACT_QUERY);
  return compact ? <SectionTabs sections={sections} /> : <SectionColumn sections={sections} />;
}

function SectionColumn({sections}: {sections: Section[]}) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => readJson(OPEN_KEY, {}));
  const isOpen = (id: string) => open[id] ?? true;
  const toggle = (id: string) => {
    const next = {...open, [id]: !isOpen(id)};
    setOpen(next);
    writeJson(OPEN_KEY, next);
  };

  const opened = sections.filter(s => isOpen(s.id));
  const key = opened.map(s => s.id).join('+');
  const [measure, height] = useHeight();
  const sizes = sectionSizes(
    opened.map(s => s.id),
    height != null && height > 0 ? height : FALLBACK_COLUMN_PX,
  );
  // closed sections keep their place: above the open ones or below them
  const firstOpen = sections.findIndex(s => isOpen(s.id));
  const closed = (above: boolean) =>
    sections
      .filter((s, i) => !isOpen(s.id) && (firstOpen === -1 || i < firstOpen) === above)
      .map(s => <Header key={s.id} section={s} open={false} onToggle={() => toggle(s.id)} />);

  return (
    <div className="sidebar">
      {closed(true)}
      {opened.length > 0 && (
        <div className="sidebar-group" ref={measure}>
          {height != null && (
            <PanelGroup key={key} direction="vertical" autoSaveId={`sam-ui-studio:sidebar:${key}`} storage={panelStorage}>
              {opened.map((s, i) => (
                <Fragment key={s.id}>
                  {i > 0 && <PanelResizeHandle className="resize-handle horizontal" />}
                  <Panel id={s.id} order={i} minSize={sizes[s.id].min} defaultSize={sizes[s.id].size}>
                    <section className="section">
                      <Header section={s} open onToggle={() => toggle(s.id)} />
                      <div className="section-body">{s.content}</div>
                    </section>
                  </Panel>
                </Fragment>
              ))}
            </PanelGroup>
          )}
        </div>
      )}
      {closed(false)}
    </div>
  );
}
