// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Meta's effects step: a highlight effect for the objects and a background
// effect for the rest, from the demo's own effect lists (EffectsUtils) and
// effect classes, run by the worker. Clicking the active effect again cycles
// its variants, as in the demo. Export renders the video with the effects
// through Meta's encoder.
import type {
  EffectUpdateEvent,
  EncodingCompletedEvent,
  EncodingStateUpdateEvent,
} from '@/common/components/video/VideoWorkerBridge';
import {
  backgroundEffects,
  highlightEffects,
  moreEffects,
  type DemoEffect,
} from '@/common/components/effects/EffectsUtils';
import type {EffectIndex, Effects} from '@/common/components/video/effects/Effects';
import {Download} from '@carbon/icons-react';
import {useEffect, useState} from 'react';
import type {StudioSessionApi} from '~/workspace/useStudioSession';

// Meta's EffectIndex enum, without loading every effect into the main thread
const BACKGROUND = 0 as EffectIndex;
const HIGHLIGHT = 1 as EffectIndex;

/** Meta's GL highlight shaders hold three masks; studio's Overlay holds any number. */
const META_MASK_SLOTS = 3;

type Active = {name: keyof Effects; variant: number; numVariants: number};

type Props = {session: StudioSessionApi; videoName: string};

function EffectGrid({
  title,
  effects,
  active,
  disabled,
  onPick,
}: {
  title: string;
  effects: DemoEffect[];
  active: Active;
  disabled: boolean;
  onPick: (effect: DemoEffect) => void;
}) {
  return (
    <div className="effect-group">
      <div className="effect-group-title">{title}</div>
      <div className="effect-grid">
        {effects.map(effect => {
          const on = active.name === effect.effectName;
          const Icon = effect.Icon;
          return (
            <button
              key={`${title}-${effect.effectName}`}
              className={on ? 'effect-button active' : 'effect-button'}
              disabled={disabled}
              onClick={() => onPick(effect)}
              title={on ? 'Click again for the next variant' : effect.title}>
              <Icon size={20} />
              <span>{effect.title}</span>
              {on && active.numVariants > 1 && (
                <span className="effect-variant">
                  {active.variant + 1}/{active.numVariants}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function EffectsSection({session, videoName}: Props) {
  const {bridge, state, meta} = session;
  const [background, setBackground] = useState<Active>({name: 'Original', variant: 0, numVariants: 3});
  const [highlight, setHighlight] = useState<Active>({name: 'Overlay', variant: 0, numVariants: 4});
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    if (bridge == null) {
      return;
    }
    // the worker is the source of truth for the applied effect and variant
    const onUpdate = (e: EffectUpdateEvent) => {
      const next = {name: e.name, variant: e.variant, numVariants: e.numVariants};
      if (e.index === BACKGROUND) {
        setBackground(next);
      } else {
        setHighlight(next);
      }
    };
    const onEncoding = (e: EncodingStateUpdateEvent) => setProgress(e.progress);
    const onEncoded = (e: EncodingCompletedEvent) => {
      setProgress(null);
      const url = URL.createObjectURL(new Blob([e.file], {type: 'video/mp4'}));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${videoName.replace(/\.[^.]+$/, '')}-effects.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    };
    bridge.addEventListener('effectUpdate', onUpdate);
    bridge.addEventListener('encodingStateUpdate', onEncoding);
    bridge.addEventListener('encodingCompleted', onEncoded);
    return () => {
      bridge.removeEventListener('effectUpdate', onUpdate);
      bridge.removeEventListener('encodingStateUpdate', onEncoding);
      bridge.removeEventListener('encodingCompleted', onEncoded);
    };
  }, [bridge, videoName]);

  const pick = (index: EffectIndex, active: Active) => (effect: DemoEffect) => {
    if (active.name === effect.effectName) {
      bridge?.setEffect(effect.effectName, index, {variant: (active.variant + 1) % active.numVariants});
    } else {
      bridge?.setEffect(effect.effectName, index);
    }
  };

  const locked = progress != null || !meta.decoded;
  const exportLocked = locked || state.jobs.length > 0;
  const capped = highlight.name !== 'Overlay' && state.objects.length > META_MASK_SLOTS;

  return (
    <div className="effects">
      <EffectGrid
        title="Selected objects"
        effects={[...highlightEffects, ...moreEffects]}
        active={highlight}
        disabled={locked}
        onPick={pick(HIGHLIGHT, highlight)}
      />
      {capped && (
        <div className="object-hint">
          This effect is Meta&apos;s shader, which draws the first {META_MASK_SLOTS} objects only.
          Overlay draws all of them.
        </div>
      )}
      <EffectGrid
        title="Background"
        effects={backgroundEffects}
        active={background}
        disabled={locked}
        onPick={pick(BACKGROUND, background)}
      />
      <div className="effect-export">
        <button
          className="button"
          disabled={exportLocked}
          onClick={() => bridge?.encode()}
          title={state.jobs.length > 0 ? 'Wait for the running track jobs' : undefined}>
          <Download size={16} />{' '}
          {progress != null ? `Exporting ${Math.round(progress * 100)}%` : 'Export video with effects'}
        </button>
      </div>
    </div>
  );
}
