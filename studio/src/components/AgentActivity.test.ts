// sam-ui (Apache-2.0). New file, not from SAM 2.
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {appendActivity} from '~/state/agentActivity';
import {initialState} from '~/state/objects';
import AgentActivity from './AgentActivity';

const render = (agentActivity: unknown[]) =>
  renderToStaticMarkup(createElement(AgentActivity, {session: {agentActivity, state: initialState, goToAgentChange: () => {}} as never}));

it('shows nothing before an agent changes the video', () => {
  expect(render([])).toBe('');
});

it('names the latest change, with Go to, while it is fresh', () => {
  const entries = appendActivity([], {
    videoId: 'v.mp4', kind: 'points', objectIds: [1], frame: 120, end: null, state: null, jobId: null, name: null, at: Date.now(),
  }, null);
  const html = render(entries);
  expect(html).toContain('Agent');
  expect(html).toContain('set clicks on Object 2, frame 121');
  expect(html).toContain('Go to');
  expect(html).toContain('aria-expanded="false"');
});

it('counts the changes once they are quiet', () => {
  const entries = appendActivity([], {
    videoId: 'v.mp4', kind: 'undo', objectIds: [1], frame: null, end: null, state: null, jobId: null, name: null, at: Date.now() - 60_000,
  }, null);
  const html = render(entries);
  expect(html).toContain('1 change');
  expect(html).not.toContain('Go to');
});
