// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Meta's effects step: selected-object effects and a background effect, from
// the demo's own effect lists (EffectsUtils) and effect classes, run by the
// worker. Unlike the demo, each object keeps its own effect: focusing an
// object only chooses which object the buttons edit, and they show that
// object's effect. A pick edits the layer's selected or top effect clip, or
// adds one over the whole video (state/effectClips.ts); the background is a
// clip too, kept with the video. Clicking the active effect again cycles its
// styles (Meta's variants). Both groups start collapsed. The video export is
// in the top bar.
import {
  backgroundEffects,
  highlightEffects,
  moreEffects,
  type DemoEffect,
} from '@/common/components/effects/EffectsUtils';
import {EFFECT_SPECS, styleIndex} from '@/common/components/video/effects/EffectParamSpecs';
import {ChevronDown, ChevronRight} from '@carbon/icons-react';
import {useState, type ReactNode} from 'react';
import {objectName} from '~/state/fileNames';
import {readJson, writeJson} from '~/lib/storage';
import {BACKGROUND_DEFAULT, type EffectClip, type EffectTarget, OVERLAY, clipToEdit} from '~/state/effectClips';
import type {StudioSessionApi} from '~/workspace/useStudioSession';

const OPEN_KEY = 'sam-ui-studio:effect-groups-open';

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
  children,
}: {
  title: string;
  effects: DemoEffect[];
  active: Active | null;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onPick: (effect: DemoEffect) => void;
  children?: ReactNode;
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
                title={on ? 'Click again for the next variant' : effect.title}>
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
    </div>
  );
}

export default function EffectsSection({session}: Props) {
  const {state, meta, effectDoc, frame, selectedClipId} = session;
  const [open, setOpen] = useState<Record<string, boolean>>(() => readJson(OPEN_KEY, {}));
  const toggle = (id: string) => {
    const next = {...open, [id]: !open[id]};
    setOpen(next);
    writeJson(OPEN_KEY, next);
  };

  const locked = session.exportProgress != null || !meta.decoded || effectDoc == null;
  const focused = state.activeId;
  const edited = (target: EffectTarget) =>
    effectDoc == null ? null : clipToEdit(effectDoc, target, frame, selectedClipId);
  const focusedObject = focused == null ? undefined : session.state.objects.find(o => o.id === focused);
  const focusedName = focused == null ? null : objectName(focusedObject ?? {id: focused});
  // an object with no clip shows the Overlay, as the preview draws it
  const active: Active | null = focused == null ? null : activeOf(edited({kind: 'object', id: focused}), OVERLAY);
  const background = activeOf(edited({kind: 'background'}), BACKGROUND_DEFAULT);

  return (
    <div className="effects">
      <EffectGrid
        title={focusedName ?? 'Selected layer'}
        effects={[...highlightEffects, ...moreEffects]}
        active={active}
        disabled={locked || focused == null}
        open={open.highlight ?? false}
        onToggle={() => toggle('highlight')}
        onPick={e => session.pickObjectEffect(e.effectName)}>
        <div className="effect-note">
          {focused == null
            ? 'Select a layer to choose its effect. Each layer keeps its own.'
            : `${focusedName}'s effect. Every layer keeps its own until you change it.`}
        </div>
      </EffectGrid>
      <EffectGrid
        title="Background"
        effects={backgroundEffects}
        active={background}
        disabled={locked}
        open={open.background ?? false}
        onToggle={() => toggle('background')}
        onPick={e => session.pickBackgroundEffect(e.effectName)}
      />
    </div>
  );
}
