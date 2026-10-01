// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Meta's effects step: selected-object effects and a background effect, from
// the demo's own effect lists (EffectsUtils) and effect classes, run by the
// worker. Unlike the demo, each object keeps its own effect: focusing an
// object only chooses which object the buttons edit, and they show that
// object's effect. The background stays one per video. Clicking the active
// effect again cycles its variants, as in the demo. Both groups start
// collapsed. The video export is in the top bar.
import type {EffectUpdateEvent} from '@/common/components/video/VideoWorkerBridge';
import {
  backgroundEffects,
  highlightEffects,
  moreEffects,
  type DemoEffect,
} from '@/common/components/effects/EffectsUtils';
import type {EffectIndex, Effects} from '@/common/components/video/effects/Effects';
import {ChevronDown, ChevronRight} from '@carbon/icons-react';
import {useEffect, useState, type ReactNode} from 'react';
import {objectName} from '~/state/fileNames';
import {readJson, writeJson} from '~/lib/storage';
import {effectOf} from '~/state/objectEffects';
import type {StudioSessionApi} from '~/workspace/useStudioSession';

// Meta's EffectIndex enum, without loading every effect into the main thread
const BACKGROUND = 0 as EffectIndex;

const OPEN_KEY = 'sam-ui-studio:effect-groups-open';

type Active = {name: string; variant: number; numVariants: number};

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
  const {bridge, state, meta, objectEffects, variantCounts} = session;
  const [background, setBackground] = useState<Active>({name: 'Original', variant: 0, numVariants: 3});
  const [open, setOpen] = useState<Record<string, boolean>>(() => readJson(OPEN_KEY, {}));
  const toggle = (id: string) => {
    const next = {...open, [id]: !open[id]};
    setOpen(next);
    writeJson(OPEN_KEY, next);
  };

  useEffect(() => {
    if (bridge == null) {
      return;
    }
    // the worker is the source of truth for the background effect and variant
    const onUpdate = (e: EffectUpdateEvent) => {
      if (e.index === BACKGROUND) {
        setBackground({name: e.name, variant: e.variant, numVariants: e.numVariants});
      }
    };
    bridge.addEventListener('effectUpdate', onUpdate);
    return () => bridge.removeEventListener('effectUpdate', onUpdate);
  }, [bridge]);

  const pickBackground = (effect: DemoEffect) => {
    if (background.name === effect.effectName) {
      bridge?.setEffect(effect.effectName as keyof Effects, BACKGROUND, {
        variant: (background.variant + 1) % background.numVariants,
      });
    } else {
      bridge?.setEffect(effect.effectName as keyof Effects, BACKGROUND);
    }
  };

  const locked = session.exportProgress != null || !meta.decoded;
  const focused = state.activeId;
  const mine = focused == null ? null : effectOf(objectEffects, focused);
  const focusedObject = focused == null ? undefined : session.state.objects.find(o => o.id === focused);
  const focusedName = focused == null ? null : objectName(focusedObject ?? {id: focused});
  const active: Active | null =
    mine == null ? null : {...mine, numVariants: variantCounts[mine.name] ?? 1};

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
        onPick={pickBackground}
      />
    </div>
  );
}
