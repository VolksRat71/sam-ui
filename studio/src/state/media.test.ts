// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {afterDelete, isDeletable} from './media';

describe('isDeletable', () => {
  it('allows uploads and linked footage only', () => {
    expect(isDeletable('uploads/abc.mp4')).toBe(true);
    expect(isDeletable('linked/abc.mov')).toBe(true);
    expect(isDeletable('linked/../gallery/clip.mp4')).toBe(false);
    expect(isDeletable('linked/')).toBe(false);
    expect(isDeletable('local/abc.mp4')).toBe(true);
    expect(isDeletable('samples/05_default_juggle.mp4')).toBe(false);
    expect(isDeletable('gallery/clip.mp4')).toBe(false);
    expect(isDeletable('uploads/../gallery/clip.mp4')).toBe(false);
    expect(isDeletable('uploads/')).toBe(false);
  });
});

describe('afterDelete', () => {
  const v = (path: string) => ({path});
  const list = [v('gallery/a.mp4'), v('uploads/b.mp4'), v('uploads/c.mp4')];

  it('keeps the current video when another one goes', () => {
    expect(afterDelete(list, 'uploads/c.mp4', list[0])).toBe(list[0]);
  });

  it('moves to the neighbour when the open one goes', () => {
    expect(afterDelete(list, 'uploads/b.mp4', list[1])?.path).toBe('uploads/c.mp4');
    expect(afterDelete(list, 'uploads/c.mp4', list[2])?.path).toBe('uploads/b.mp4');
  });

  it('falls back to the empty state when nothing is left', () => {
    expect(afterDelete([v('uploads/b.mp4')], 'uploads/b.mp4', v('uploads/b.mp4'))).toBeNull();
  });
});
