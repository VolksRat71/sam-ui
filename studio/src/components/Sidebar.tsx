// sam-ui (Apache-2.0). New file, not from SAM 2.
// Fixed dock order on desktop; the same sections become tabs on compact screens.
import {ChevronDown, ChevronRight} from '@carbon/icons-react';
import {useState, type ReactNode} from 'react';
import {COMPACT_QUERY, useMediaQuery} from '~/lib/layout';
import {readJson, writeJson} from '~/lib/storage';
export type Section = {id: string; title: string; badge?: ReactNode; content: ReactNode};
const OPEN_KEY = 'sam-ui-suite:sections-open';
const TAB_KEY = 'sam-ui-studio:sections-tab';
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
  const [tab, setTab] = useState(() => readJson<string>(TAB_KEY, 'review'));
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
  return <div className="sidebar suite-dock">{sections.map(section => {
    const expanded = open[section.id] ?? section.id === 'review';
    return <section className="section" key={section.id}>
      <Header section={section} open={expanded} onToggle={() => {
        const next = {...open, [section.id]: !expanded};
        setOpen(next); writeJson(OPEN_KEY, next);
      }} />
      <div className="section-body" hidden={!expanded}>{section.content}</div>
    </section>;
  })}</div>;
}
