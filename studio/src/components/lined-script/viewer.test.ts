import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {Filmstrip, FilmstripPlayhead, FrameThumbnail} from './viewer';

describe('continuous filmstrip', () => {
  it('provides one whole-clip slider with passive thumbnails and frame-exact playhead', () => {
    const html = renderToStaticMarkup(createElement(Filmstrip, {numFrames: 247, frameIndex: 216, onSeek: () => {}},
      createElement(FrameThumbnail, null, createElement('img', {src: 'real-frame.png', alt: ''})),
      createElement(FilmstripPlayhead, {frameIndex: 216, numFrames: 247}),
    ));
    expect(html.match(/role="slider"/g)).toHaveLength(1);
    expect(html).toContain('aria-valuetext="Frame 217 of 247"');
    expect(html).toContain('aria-valuemin="1"');
    expect(html).toContain('aria-valuemax="247"');
    expect(html).not.toContain('<button');
    expect(html).toContain(`left:min(${216 / 246 * 100}%, calc(100% - 2px))`);
  });
});

it('keeps inspection buttons outside the accessible slider', () => {
  const html = renderToStaticMarkup(createElement(Filmstrip, {numFrames: 247, frameIndex: 0, onSeek: () => {}}, createElement('button', {type: 'button'}, 'Inspect matte')));
  expect(html).toMatch(/<button[^>]*>Inspect matte<\/button><div[^>]*role="slider"/);
});
