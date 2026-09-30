// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The pure parts of studio's After Effects round trip (the desktop app's main
// process does the talking, desktop/src/ae-roto.js): what the Export menu
// offers, how a bridge failure reads, how an AE item is described, and the
// Vector JSON an export hands over.
import type {AeError, AeMediaItem} from '~/lib/desktop';
import {unzipStored} from '~/lib/zip';
import type {VectorJson} from './contours';
import {RELEASES_URL} from './engines';

export const AE_INSTALL_URL = 'https://github.com/VolksRat71/after-effects-mcp-vision';

/** A video opened in place from After Effects (the backend's data/linked.py). */
export function isAeVideo(path: string): boolean {
  return path.startsWith('linked/') && path.length > 'linked/'.length && !path.split('/').includes('..');
}

export type AeExportOffer =
  | {kind: 'ready'}
  | {kind: 'unavailable'; why: string; href?: string; hrefLabel?: string};

/**
 * The Export menu's After Effects entry. Only the desktop app can reach AE,
 * and only a video opened from AE can go back (its frames are AE's frames).
 */
export function aeExportOffer(o: {desktop: boolean; backend: boolean; videoPath: string; tracked: number}): AeExportOffer {
  if (!o.desktop) {
    return {
      kind: 'unavailable',
      why: o.backend ? 'Desktop app only: it talks to After Effects on this Mac.' : 'Needs the desktop app.',
      href: RELEASES_URL,
      hrefLabel: 'Download the desktop app',
    };
  }
  if (!isAeVideo(o.videoPath)) {
    return {kind: 'unavailable', why: 'Open the video with Media > Open from After Effects first, so its frames are AE’s frames.'};
  }
  if (o.tracked === 0) {
    return {kind: 'unavailable', why: 'Track an object first.'};
  }
  return {kind: 'ready'};
}

/** A bridge failure as a sentence, with a link when installing or updating the extension fixes it. */
export function bridgeNotice(e: AeError): {text: string; link: {href: string; label: string} | null} {
  const href = e.installUrl ?? AE_INSTALL_URL;
  switch (e.state) {
    case 'not-installed':
      return {text: 'The After Effects bridge (AE MCP Vision) is not installed on this Mac.', link: {href, label: 'Install AE MCP Vision'}};
    case 'outdated':
      return {text: 'The AE MCP Vision extension is too old for this. Update it, then reopen its panel in After Effects.', link: {href, label: 'Update AE MCP Vision'}};
    case 'not-running':
      return {text: 'After Effects is not answering. Open After Effects, then Window > Extensions > AE MCP Vision.', link: null};
    default:
      return {text: e.message, link: null};
  }
}

function fps(rate: number): string {
  return String(Math.round(rate * 1000) / 1000);
}

/** "1920×1080 · 23.976 fps · 300 frames" */
export function describeItem(i: Pick<AeMediaItem, 'width' | 'height' | 'frameRate' | 'frames'>): string {
  return `${i.width}×${i.height} · ${fps(i.frameRate)} fps · ${i.frames} frames`;
}

/** The Vector JSON documents in a studio vectors export (zip), in object order. */
export function vectorsFromZip(bytes: Uint8Array): VectorJson[] {
  const dec = new TextDecoder();
  return unzipStored(bytes)
    .filter(e => e.name.endsWith('.json'))
    .map(e => {
      const v = JSON.parse(dec.decode(e.data)) as VectorJson;
      if (v.version !== 1 || !Array.isArray(v.add) || !Array.isArray(v.sub)) {
        throw new Error(`${e.name} is not Vector JSON`);
      }
      return v;
    });
}
