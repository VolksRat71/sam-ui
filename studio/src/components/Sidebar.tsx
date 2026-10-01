// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The right-hand column: collapsible sections. With more than one open they
// share the column through a draggable divider; a closed section keeps only
// its header. Below the desktop width (lib/layout.ts) the column is a
// panel under the preview instead, and the sections are tabs.
import {ChevronDown, ChevronRight} from '@carbon/icons-react';
import {Fragment, useState, type ReactNode} from 'react';
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

/** Starting share of the column per section, before any drag. */
const WEIGHT: Record<string, number> = {media: 25, objects: 45, effects: 30};

function defaultSize(id: string, opened: Section[]): number {
  const total = opened.reduce((sum, s) => sum + (WEIGHT[s.id] ?? 30), 0);
  return ((WEIGHT[id] ?? 30) / total) * 100;
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
        <PanelGroup
          key={key}
          direction="vertical"
          autoSaveId={`sam-ui-studio:sidebar:${key}`}
          storage={panelStorage}
          className="sidebar-group">
          {opened.map((s, i) => (
            <Fragment key={s.id}>
              {i > 0 && <PanelResizeHandle className="resize-handle horizontal" />}
              <Panel id={s.id} order={i} minSize={12} defaultSize={defaultSize(s.id, opened)}>
                <section className="section">
                  <Header section={s} open onToggle={() => toggle(s.id)} />
                  <div className="section-body">{s.content}</div>
                </section>
              </Panel>
            </Fragment>
          ))}
        </PanelGroup>
      )}
      {closed(false)}
    </div>
  );
}
