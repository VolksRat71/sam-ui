// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Meta's effects step: selected-object effects and a background effect, from
// the demo's own effect lists (EffectsUtils) and effect classes, run by the
// worker. Effects are clips (state/effectClips.ts) with frame ranges, shown
// on the timeline. Each group's tiles change ONE clip, named above them: the
// selected clip, else the clip on the playhead; with neither, a tile adds a
// clip (over the whole video on a layer with none). "Add effect" always adds
// another clip at the playhead: the next tile picks its effect. Clicking the
// active effect again cycles its styles (Meta's variants). The selected
// clip's settings follow the tiles. Both groups start collapsed. The video
// export is in the top bar.
import {
  backgroundEffects,
  highlightEffects,
  moreEffects,
  type DemoEffect,
} from '@/common/components/effects/EffectsUtils';
import type {EffectParams} from '@/common/components/video/effects/Effect';
import {EFFECT_SPECS, type ParamSpec, paramShown, styleIndex} from '@/common/components/video/effects/EffectParamSpecs';
import {Add, BringForward, ChevronDown, ChevronRight, Copy, Cut, Reset, SendBackward, TrashCan} from '@carbon/icons-react';
import {useEffect, useState, type ReactNode} from 'react';
import {readJson, writeJson} from '~/lib/storage';
import {IMAGE_TYPES} from '~/state/effectImages';
import {
  BACKGROUND_DEFAULT,
  type EffectClip,
  type EffectTarget,
  OVERLAY,
  cleanText,
  clipToEdit,
  normalizeParams,
  overlapNeighbour,
  sameTarget,
  withStyle,
} from '~/state/effectClips';
import type {StudioSessionApi} from '~/workspace/useStudioSession';
import {clipFrames, clipTitle, effectTitle, targetName} from './effectPresentation';

const OPEN_KEY = 'sam-ui-studio:effect-groups-open';
/** Effects people use to hide something: their settings say how far the mask can be trusted. */
const OBSCURING = new Set(['PixelateMask', 'BlurMask', 'Pixelate', 'BackgroundBlur']);

type Active = {name: string; variant: number; numVariants: number};

/** What a grid shows as active: the clip a pick would edit, or the stage's default with none. */
function activeOf(clip: EffectClip | null, fallback: string): Active {
  const name = clip?.effect ?? fallback;
  const style = EFFECT_SPECS[name]?.params.style;
  return {
    name,
    variant: clip == null ? 0 : styleIndex(name, clip.params),
    numVariants: style?.kind === 'choice' ? style.options.length : 1,
  };
}

type Props = {session: StudioSessionApi};

function EffectGrid({
  title,
  effects,
  active,
  disabled,
  open,
  onToggle,
  onPick,
  tileTitle,
  children,
  after,
}: {
  title: string;
  effects: DemoEffect[];
  active: Active | null;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onPick: (effect: DemoEffect) => void;
  tileTitle: (effect: DemoEffect, on: boolean) => string;
  children?: ReactNode;
  after?: ReactNode;
}) {
  const current = active == null ? '' : (effects.find(e => e.effectName === active.name)?.title ?? active.name);
  return (
    <div className="effect-group">
      <button className="effect-group-title" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{title}</span>
        {current !== '' && <span className="effect-current">{current}</span>}
      </button>
      {open && children}
      {open && (
        <div className="effect-grid">
          {effects.map(effect => {
            const on = active?.name === effect.effectName;
            const Icon = effect.Icon;
            return (
              <button
                key={`${title}-${effect.effectName}`}
                className={on ? 'effect-button active' : 'effect-button'}
                aria-pressed={on}
                disabled={disabled}
                onClick={() => onPick(effect)}
                title={tileTitle(effect, on)}>
                <Icon size={20} />
                <span>{effect.title}</span>
                {on && active != null && active.numVariants > 1 && (
                  <span className="effect-variant">
                    {active.variant + 1}/{active.numVariants}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {open && after}
    </div>
  );
}

/** A number typed in a field: kept as typed until it is a value in range, then sent on; blur shows the stored value again. */
function NumberField({label, value, min, max, step, onCommit}: {label: string; value: number; min: number; max: number; step: number; onCommit: (v: number) => void}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={draft ?? String(value)}
      onChange={e => {
        setDraft(e.target.value);
        const v = e.target.valueAsNumber;
        if (Number.isFinite(v) && v >= min && v <= max) {
          onCommit(v);
        }
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/**
 * A text setting: kept as typed while focused, sent on (cleaned) whenever it
 * is valid text, so clearing it to retype never snaps back to the default;
 * blur shows the stored value. Lines past the last join it. A plain textarea, so the video's and the
 * timeline's shortcuts leave its keys alone.
 */
function TextField({id, label, value, maxLength, maxLines, onCommit}: {id: string; label: string; value: string; maxLength: number; maxLines: number; onCommit: (v: string) => void}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  return (
    <div className="fx-param">
      <label className="fx-param-label" htmlFor={id}>{label}</label>
      <div className="fx-text">
        <textarea
          id={id}
          rows={Math.min(maxLines, Math.max(1, shown.split('\n').length))}
          maxLength={maxLength}
          aria-describedby={`${id}-count`}
          spellCheck={false}
          value={shown}
          onChange={e => {
            // a line past the last one (Enter there, or a paste) joins it, as stored text does
            const lines = e.target.value.split('\n');
            const v = lines.length <= maxLines ? e.target.value : [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(' ')].join('\n');
            setDraft(v);
            const clean = cleanText(v, maxLength, maxLines);
            if (clean !== '') {
              onCommit(clean);
            }
          }}
          onBlur={() => setDraft(null)}
        />
        <span className="fx-count" id={`${id}-count`}>
          {shown.length}/{maxLength} characters, {maxLines} lines at most
        </span>
      </div>
    </div>
  );
}

/** Title's quick positions: the text block's centre. */
const POSITIONS: Record<string, {x: number; y: number}> = {Top: {x: 0.5, y: 0.15}, Centre: {x: 0.5, y: 0.5}, Bottom: {x: 0.5, y: 0.85}};

/** One control per setting of the selected clip (EFFECT_SPECS): edits redraw at once, no track job. */
function ClipSettings({clip, session, layerColor, title}: {clip: EffectClip; session: StudioSessionApi; layerColor: string; title: string}) {
  const spec = EFFECT_SPECS[clip.effect];
  const n = session.meta.numFrames;
  const set = (key: string, v: EffectParams[string], step = `${clip.id}:${key}`) =>
    session.updateClip(clip.id, {params: {...clip.params, [key]: v}}, step);
  const style = String(clip.params.style ?? '');
  // Reset keeps a picked picture and typed text: content, not settings
  const pictures = Object.fromEntries(Object.entries(spec?.params ?? {}).flatMap(([k, p]) => (p.kind === 'image' || p.kind === 'text' ? [[k, clip.params[k]]] : [])));
  const styled = spec == null ? clip.params : {...withStyle(clip.effect, normalizeParams(clip.effect, {}), style), ...pictures};
  const atStyle = JSON.stringify(styled) === JSON.stringify(clip.params);
  const canSplit = clip.start < session.frame && session.frame < clip.end;
  const passes = (direction: 'up' | 'down') => session.effectDoc != null && overlapNeighbour(session.effectDoc, clip.id, direction) != null;
  const control = (key: string, p: ParamSpec) => {
    const id = `fx-${clip.id}-${key}`;
    if (p.kind === 'choice') {
      return (
        <div className="fx-param" key={key}>
          <span className="fx-param-label" id={id}>{p.label}</span>
          <div className="fx-choice" role="group" aria-labelledby={id}>
            {p.options.map(o => (
              <button
                key={o}
                type="button"
                aria-pressed={clip.params[key] === o}
                onClick={() => session.updateClip(clip.id, {params: key === 'style' ? withStyle(clip.effect, clip.params, o) : {...clip.params, [key]: o}})}>
                {o}
              </button>
            ))}
          </div>
        </div>
      );
    }
    if (p.kind === 'color') {
      const follow = clip.params[key] === 'layer';
      const hex = follow ? layerColor : String(clip.params[key]);
      return (
        <div className="fx-param" key={key}>
          <label className="fx-param-label" htmlFor={id}>{p.label}</label>
          <div className="fx-color">
            <input id={id} type="color" value={hex} disabled={follow} onChange={e => set(key, e.target.value)} />
            {clip.target.kind === 'object' && (
              <label className="fx-follow">
                <input type="checkbox" checked={follow} onChange={e => session.updateClip(clip.id, {params: {...clip.params, [key]: e.target.checked ? 'layer' : layerColor}})} />
                Follow layer colour
              </label>
            )}
          </div>
        </div>
      );
    }
    if (p.kind === 'text') {
      return <TextField key={key} id={id} label={p.label} value={String(clip.params[key] ?? '')} maxLength={p.maxLength} maxLines={p.maxLines} onCommit={v => set(key, v)} />;
    }
    if (p.kind === 'image') {
      const picked = String(clip.params[key] ?? '');
      const missing = picked !== '' && session.missingImages.has(picked);
      return (
        <div className="fx-param" key={key}>
          <label className="fx-param-label" htmlFor={id}>{p.label}</label>
          <input
            id={id}
            type="file"
            accept={IMAGE_TYPES.join(',')}
            aria-describedby={`${id}-note`}
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = ''; // the same file again is a new pick
              if (file != null) {
                void session.pickEffectImage(clip.id, file);
              }
            }}
          />
          <p className="effect-note" id={`${id}-note`}>
            {missing
              ? 'This picture is not stored in this browser (another browser, or cleared site data), so the colour shows instead. Choose it again to use it.'
              : picked === ''
                ? 'PNG, JPEG or WebP, scaled down to the video if larger. The colour shows until you choose one.'
                : 'PNG, JPEG or WebP, kept in this browser. Choose another to replace it.'}
          </p>
        </div>
      );
    }
    const v = Number(clip.params[key]);
    const presets =
      clip.effect === 'Title' && key === 'x' ? (
        <div className="fx-param" key="position">
          <span className="fx-param-label" id={`${id}-presets`}>Position</span>
          <div className="fx-choice" role="group" aria-labelledby={`${id}-presets`}>
            {Object.entries(POSITIONS).map(([name, at]) => (
              <button
                key={name}
                type="button"
                aria-pressed={clip.params.x === at.x && clip.params.y === at.y}
                onClick={() => session.updateClip(clip.id, {params: {...clip.params, ...at}})}>
                {name}
              </button>
            ))}
          </div>
        </div>
      ) : null;
    // the field shows a percentage of the frame height for such settings; the slider and the doc keep the fraction
    const k = p.percentOfHeight ? 100 : 1;
    const shown = (x: number) => Math.round(x * k * 1e6) / 1e6;
    const label = p.percentOfHeight ? `${p.label}, % of frame height` : p.label;
    return [
      presets,
      <div className="fx-param" key={key}>
        <label className="fx-param-label" htmlFor={id} title={label}>{p.percentOfHeight ? `${p.label} %` : p.label}</label>
        <div className="fx-number">
          <input id={id} type="range" min={p.min} max={p.max} step={p.step} value={v} aria-valuetext={p.percentOfHeight ? `${shown(v)} %` : undefined} onChange={e => set(key, e.target.valueAsNumber)} />
          <NumberField label={`${label}, ${shown(p.min)} to ${shown(p.max)}`} value={shown(v)} min={shown(p.min)} max={shown(p.max)} step={shown(p.step)} onCommit={x => set(key, x / k)} />
        </div>
      </div>,
    ];
  };
  return (
    <div className="fx-settings" role="group" aria-label={`${title} settings`}>
      <div className="fx-settings-head">
        <strong>{title}</strong>
        <div className="fx-clip-actions">
          <button
            className="link-button"
            disabled={!canSplit}
            aria-label="Split at playhead"
            onClick={() => session.splitClip(clip.id)}
            title={canSplit ? 'Split this clip in two at the playhead (S in the timeline)' : 'Put the playhead inside this clip, past its first frame, to split it'}>
            <Cut size={14} /> Split
          </button>
          <button className="link-button" onClick={() => session.duplicateClip(clip.id)} title="Copy this clip right after it, its animation from the start (D in the timeline)">
            <Copy size={14} /> Duplicate
          </button>
          <button
            className="link-button"
            disabled={!passes('up')}
            onClick={() => session.reorderClip(clip.id, 'up')}
            title="Draw this clip over the next clip above it on its frames (Alt+Up on the clip in the timeline)">
            <BringForward size={14} /> Move up
          </button>
          <button
            className="link-button"
            disabled={!passes('down')}
            onClick={() => session.reorderClip(clip.id, 'down')}
            title="Draw this clip under the next clip below it on its frames (Alt+Down on the clip in the timeline)">
            <SendBackward size={14} /> Move down
          </button>
          <button className="link-button" onClick={() => session.removeClip(clip.id)} title="Remove this clip (Delete in the timeline)">
            <TrashCan size={14} /> Remove clip
          </button>
        </div>
      </div>
      <div className="fx-param">
        <span className="fx-param-label" id={`fx-${clip.id}-range`}>Frames</span>
        <div className="fx-range" role="group" aria-labelledby={`fx-${clip.id}-range`}>
          <NumberField label="First frame" value={clip.start + 1} min={1} max={clip.end} step={1} onCommit={v => session.trimClip(clip.id, 'start', v - 1, `${clip.id}:start`)} />
          <span aria-hidden="true">to</span>
          <NumberField label="Last frame" value={clip.end} min={clip.start + 1} max={n} step={1} onCommit={v => session.trimClip(clip.id, 'end', v, `${clip.id}:end`)} />
        </div>
      </div>
      {spec == null ? (
        <p className="effect-note">This effect comes from a newer build of sam-ui: its settings are kept as they are.</p>
      ) : (
        Object.entries(spec.params)
          .filter(([, p]) => paramShown(p, clip.params))
          .map(([key, p]) => control(key, p))
      )}
      {OBSCURING.has(clip.effect) && (
        <p className="effect-note">
          {clip.target.kind === 'object'
            ? 'Follows the mask: if tracking misses a frame, the subject shows.'
            : 'Covers the whole frame: a layer drawn on top stays clear only where tracking found it.'}
        </p>
      )}
      {spec != null && (
        <button className="button subtle compact" disabled={atStyle} onClick={() => session.updateClip(clip.id, {params: styled})}>
          <Reset size={14} /> Reset to {style !== '' ? `${style} defaults` : 'defaults'}
        </button>
      )}
    </div>
  );
}

export default function EffectsSection({session}: Props) {
  const {state, meta, effectDoc, frame, selectedClipId} = session;
  const [open, setOpen] = useState<Record<string, boolean>>(() => readJson(OPEN_KEY, {}));
  // the group whose next tile adds a clip ("Add effect"), until it does or is cancelled
  const [adding, setAdding] = useState<'object' | 'background' | null>(null);
  const toggle = (id: string) => {
    const next = {...open, [id]: !open[id]};
    setOpen(next);
    writeJson(OPEN_KEY, next);
  };

  const locked = session.exportProgress != null || !meta.decoded || effectDoc == null;
  const focused = state.activeId;
  useEffect(() => setAdding(a => (a === 'object' ? null : a)), [focused]);
  const focusedObject = focused == null ? undefined : state.objects.find(o => o.id === focused);
  const selected = effectDoc?.clips.find(c => c.id === selectedClipId) ?? null;
  // a clip selected anywhere (timeline, undo) opens its group, so its settings show
  const selectedGroup = selected == null ? null : selected.target.kind === 'object' ? 'highlight' : 'background';
  useEffect(() => {
    if (selectedGroup != null) {
      setOpen(o => (o[selectedGroup] ? o : {...o, [selectedGroup]: true}));
    }
  }, [selectedGroup, selectedClipId]);

  const group = (kind: 'object' | 'background', target: EffectTarget | null, fallback: string) => {
    const edited = target == null || effectDoc == null ? null : clipToEdit(effectDoc, target, frame, selectedClipId);
    const hasClips = target != null && effectDoc != null && effectDoc.clips.some(c => sameTarget(c.target, target));
    const isAdding = adding === kind;
    const name = target == null ? '' : targetName(target, state.objects);
    const pick = (e: DemoEffect) => {
      if (target == null) {
        return;
      }
      if (isAdding) {
        session.addClip(target, e.effectName);
        setAdding(null);
      } else if (kind === 'object') {
        session.pickObjectEffect(e.effectName);
      } else {
        session.pickBackgroundEffect(e.effectName);
      }
    };
    const tileTitle = (e: DemoEffect, on: boolean) =>
      isAdding
        ? `Add a ${e.title} clip at frame ${frame + 1}`
        : edited != null
          ? on
            ? `Next ${e.title} style for ${clipTitle(edited)}`
            : `Change ${clipTitle(edited)} to ${e.title}`
          : hasClips
            ? `Add a ${e.title} clip at frame ${frame + 1}`
            : `Give ${name} ${e.title} over the whole video`;
    // the live part names only what tiles act on, so playback and scrubbing never
    // re-announce it; frame numbers follow outside it
    const [status, where] =
      target == null
        ? [null, null]
        : isAdding
          ? [<>Choose the effect for a new clip</>, <> at frame {frame + 1}.</>]
          : edited != null
            ? [
                <>
                  Tiles change <strong>{clipTitle(edited)}</strong>
                  {edited.id === selectedClipId ? '' : ' (on the playhead)'}
                </>,
                <>, {clipFrames(edited)}.</>,
              ]
            : hasClips
              ? [<>No {name} clip on this frame: a tile adds one</>, <> at frame {frame + 1}.</>]
              : [<>A tile gives {name} that effect over the whole video.</>, null];
    return {
      active: target == null || isAdding ? null : activeOf(edited, fallback),
      pick,
      tileTitle,
      header:
        target == null ? null : (
          <div className="fx-command">
            <p className="effect-note">
              <span role="status">{status}</span>
              {where}
            </p>
            <button
              className="button compact"
              disabled={locked}
              onClick={() => setAdding(isAdding ? null : kind)}
              onKeyDown={e => e.key === 'Escape' && setAdding(null)}
              title={isAdding ? 'Cancel: tiles go back to changing the clip' : `Add another clip to ${name} at frame ${frame + 1} (3 s); the next tile picks its effect`}>
              {isAdding ? 'Cancel' : <><Add size={14} /> Add effect</>}
            </button>
          </div>
        ),
      settings:
        selected != null && target != null && sameTarget(selected.target, target) ? (
          <ClipSettings
            clip={selected}
            session={session}
            layerColor={kind === 'object' ? (focusedObject?.color ?? '#ffffff') : '#ffffff'}
            title={`${name} · ${effectTitle(selected.target, selected.effect)}`}
          />
        ) : null,
    };
  };
  const layer = group('object', focused == null ? null : {kind: 'object', id: focused}, OVERLAY);
  const background = group('background', {kind: 'background'}, BACKGROUND_DEFAULT);

  return (
    <div className="effects">
      <EffectGrid
        title={focusedObject != null ? targetName({kind: 'object', id: focusedObject.id}, state.objects) : 'Selected layer'}
        effects={[...highlightEffects, ...moreEffects]}
        active={layer.active}
        disabled={locked || focused == null}
        open={open.highlight ?? false}
        onToggle={() => toggle('highlight')}
        onPick={layer.pick}
        tileTitle={layer.tileTitle}
        after={layer.settings}>
        {focused == null ? <div className="effect-note">Select a layer to give it effects. Each layer keeps its own.</div> : layer.header}
      </EffectGrid>
      <EffectGrid
        title="Background"
        effects={backgroundEffects}
        active={background.active}
        disabled={locked}
        open={open.background ?? false}
        onToggle={() => toggle('background')}
        onPick={background.pick}
        tileTitle={background.tileTitle}
        after={background.settings}>
        {background.header}
      </EffectGrid>
    </div>
  );
}
