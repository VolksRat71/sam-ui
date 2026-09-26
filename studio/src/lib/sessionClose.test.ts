// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {recordClose, recordOpen, whenClosed} from './sessionClose';

describe('whenClosed', () => {
  it('resolves at once for a video with no session here', async () => {
    await expect(whenClosed('uploads/none.mp4')).resolves.toBeUndefined();
  });

  it('waits for the unmount and then for the close itself', async () => {
    const path = 'uploads/a.mp4';
    recordOpen(path);
    const order: string[] = [];
    const waiting = whenClosed(path).then(() => order.push('closed'));
    await new Promise(r => setTimeout(r, 60));
    expect(order).toEqual([]); // still mounted
    let finish!: () => void;
    recordClose(path, new Promise<void>(r => (finish = r)));
    await new Promise(r => setTimeout(r, 60));
    expect(order).toEqual([]); // unmounted, close still in flight
    finish();
    await waiting;
    expect(order).toEqual(['closed']);
  });

  it('gives up if the session never closes', async () => {
    recordOpen('uploads/stuck.mp4');
    await expect(whenClosed('uploads/stuck.mp4', 50)).rejects.toThrow(/did not close/);
  });
});
