// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The worker's moveClicks against a stub backend: it sends the engine on
// screen, as setPoints does, and none (null, SAM 2's rule) when it has none.
import {afterEach, describe, expect, it, vi} from 'vitest';
import StudioSession from './StudioSession';

type Sent = {query: string; variables: {input: Record<string, unknown>}};

function session(sent: Sent[]): StudioSession {
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Sent);
    return new Response(JSON.stringify({data: {moveClicks: []}}), {headers: {'Content-Type': 'application/json'}});
  });
  const s = new StudioSession({} as never, {} as never, () => {});
  s.init('http://backend.test');
  const open = s as unknown as {_sessionId: string; _showChanged: () => Promise<void>};
  open._sessionId = 's1';
  open._showChanged = async () => {}; // the preview's side, not under test here
  return s;
}

describe('StudioSession moveClicks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the engine on screen, so SAM 3 can take a frame of negatives alone', async () => {
    const sent: Sent[] = [];
    await session(sent).moveClicks(4, 1, 2, 'sam3');
    expect(sent).toHaveLength(1);
    expect(sent[0].query).toContain('moveClicks');
    expect(sent[0].variables.input).toEqual({sessionId: 's1', frameIndex: 4, fromObjectId: 1, toObjectId: 2, engine: 'sam3'});
  });

  it('sends null with no engine, which the backend holds to SAM 2', async () => {
    const sent: Sent[] = [];
    await session(sent).moveClicks(4, 1, 2);
    expect(sent[0].variables.input.engine).toBeNull();
  });
});
