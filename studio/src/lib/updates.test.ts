// sam-ui (Apache-2.0). New file, not from SAM 2.
import {afterEach, describe, expect, it} from 'vitest';
import {asReleaseNotice, updateText, updatesBridge} from './updates';

const URL = 'https://github.com/VolksRat71/sam-ui/releases/tag/v0.3.0';
const notice = {version: '0.3.0', name: 'sam-ui v0.3.0', url: URL, current: '0.2.0'};

describe('asReleaseNotice', () => {
  it('takes what the desktop app sends', () => {
    expect(asReleaseNotice(notice)).toEqual(notice);
    expect(asReleaseNotice({...notice, version: '0.3.0-beta.1', name: undefined})).toEqual({
      ...notice,
      version: '0.3.0-beta.1',
      name: 'sam-ui v0.3.0-beta.1',
    });
  });

  it('refuses anything else, including a link off the release pages', () => {
    for (const bad of [
      null,
      undefined,
      'v0.3.0',
      {...notice, version: 'latest'},
      {...notice, current: 2},
      {...notice, url: 'https://evil.io/VolksRat71/sam-ui/releases/tag/v0.3.0'},
      {...notice, url: 'https://github.com/VolksRat71/sam-ui-evil/releases'},
      {...notice, url: 'http://github.com/VolksRat71/sam-ui/releases/tag/v0.3.0'},
    ]) {
      expect(asReleaseNotice(bad)).toBeNull();
    }
  });
});

describe('updateText', () => {
  it('names both versions and says it does not install itself', () => {
    expect(updateText(notice)).toBe(
      "sam-ui 0.3.0 is available (you have 0.2.0). It doesn't install itself yet: download it from the release page and replace the app.",
    );
  });
});

describe('updatesBridge', () => {
  const g = globalThis as {samUiDesktop?: unknown};
  afterEach(() => {
    delete g.samUiDesktop;
  });

  it('is null in a browser and for an older desktop app', () => {
    expect(updatesBridge()).toBeNull();
    g.samUiDesktop = {setupSam3: () => {}};
    expect(updatesBridge()).toBeNull();
  });

  it('is the bridge when the desktop app exposes it', () => {
    const updates = {pending: async () => null, onAvailable: () => () => {}, dismiss: () => {}, openRelease: () => {}};
    g.samUiDesktop = {setupSam3: () => {}, updates};
    expect(updatesBridge()).toBe(updates);
  });
});
