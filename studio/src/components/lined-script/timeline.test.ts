import {describe, expect, it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {LookClip} from './timeline';

describe('Look clip hit area', () => {
  it('bounds the button to its exclusive frame range and retains caller positioning', () => {
    const html = renderToStaticMarkup(createElement(LookClip, {
      id: 'partial-look',
      color: '#00c9de',
      clip: {start: 20, end: 40, effect: 'Outline'},
      numFrames: 100,
      style: {top: 7, height: 16, transform: 'translateY(2px)', left: '0%', width: '100%'},
    }));
    const button = html.match(/^<button\b[^>]*>/)?.[0] ?? '';
    expect(button).toContain('left:20%');
    expect(button).toContain('width:20%');
    expect(button).toContain('top:7px');
    expect(button).toContain('height:16px');
    expect(button).toContain('transform:translateY(2px)');
    expect(button).toContain('aria-label="Outline, frames 21–40"');
  });
});
