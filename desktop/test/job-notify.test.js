// sam-ui (Apache-2.0). New file, not from SAM 2.
// node --test test/job-notify.test.js   (no Electron: the Notification and window are fakes)
'use strict';

const assert = require('node:assert');
const {describe, test} = require('node:test');

const {createJobNotifier, notificationText, notifyEnabled, parseJobDone} = require('../src/job-notify');

/** A Notification that records itself; `click()` fires its click handler. */
function fakeNotificationClass() {
  const made = [];
  class FakeNotification {
    constructor(opts) {
      this.opts = opts;
      this.handlers = {};
      this.shown = false;
      made.push(this);
    }
    on(name, fn) {
      this.handlers[name] = fn;
    }
    show() {
      this.shown = true;
    }
    click() {
      this.handlers.click();
    }
  }
  FakeNotification.made = made;
  return FakeNotification;
}

function fakeWindow({focused = false, minimized = false} = {}) {
  const calls = [];
  return {
    calls,
    sent: [],
    isFocused: () => focused,
    isMinimized: () => minimized,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    webContents: {send(channel, payload) {
      calls.push('send');
      this.owner.sent.push({channel, payload});
    }},
  };
}

function setup({on = true, win = fakeWindow()} = {}) {
  if (win != null) win.webContents.owner = win;
  const Notification = fakeNotificationClass();
  let enabled = on;
  const jobDone = createJobNotifier({Notification, enabled: () => enabled, getWindow: () => win});
  return {jobDone, Notification, win, setEnabled: v => (enabled = v)};
}

const done = (extra = {}) => ({kind: 'track', ok: true, objectIds: [2, 0], name: 'Dog', ...extra});

describe('when it notifies', () => {
  test('off by default: only "notifyJobDone": true turns it on', () => {
    for (const settings of [{}, null, {notifyJobDone: 'true'}, {notifyJobDone: 1}, {notifyJobDone: false}]) {
      assert.strictEqual(notifyEnabled(settings), false, JSON.stringify(settings));
    }
    assert.strictEqual(notifyEnabled({notifyJobDone: true}), true);
  });

  test('nothing while the setting is off', () => {
    const {jobDone, Notification} = setup({on: false});
    assert.strictEqual(jobDone(done()), false);
    assert.strictEqual(Notification.made.length, 0);
  });

  test('nothing while the window is focused', () => {
    const {jobDone, Notification} = setup({win: fakeWindow({focused: true})});
    assert.strictEqual(jobDone(done()), false);
    assert.strictEqual(Notification.made.length, 0);
  });

  test('nothing once the window is gone', () => {
    const {jobDone, Notification} = setup({win: null});
    assert.strictEqual(jobDone(done()), false);
    assert.strictEqual(Notification.made.length, 0);
  });

  test('one notification when the window is not focused', () => {
    const {jobDone, Notification} = setup();
    assert.strictEqual(jobDone(done()), true);
    assert.strictEqual(Notification.made.length, 1);
    assert.ok(Notification.made[0].shown);
    assert.deepStrictEqual(Notification.made[0].opts, {title: 'Track finished', body: 'Dog and 1 more: ready to review.'});
  });

  test('the setting is read on every job', () => {
    const {jobDone, setEnabled} = setup({on: false});
    assert.strictEqual(jobDone(done()), false);
    setEnabled(true);
    assert.strictEqual(jobDone(done()), true);
  });
});

describe('a click', () => {
  test('focuses the window and sends the jump', () => {
    const {jobDone, Notification, win} = setup();
    jobDone(done());
    assert.deepStrictEqual(win.calls, []); // nothing until the click
    Notification.made[0].click();
    assert.deepStrictEqual(win.calls, ['show', 'focus', 'send']);
    assert.deepStrictEqual(win.sent, [{channel: 'jobs:open', payload: {kind: 'track', objectIds: [2, 0]}}]);
  });

  test('restores a minimized window first', () => {
    const {jobDone, Notification, win} = setup({win: fakeWindow({minimized: true})});
    jobDone(done());
    Notification.made[0].click();
    assert.deepStrictEqual(win.calls, ['restore', 'show', 'focus', 'send']);
  });
});

describe('the words', () => {
  test('a failed job says so', () => {
    assert.deepStrictEqual(notificationText(parseJobDone(done({ok: false, objectIds: [0]}))), {
      title: 'Track failed',
      body: 'Dog: the track did not finish.',
    });
  });

  test('the name is bounded, one line, and defaults to the first object', () => {
    assert.strictEqual(parseJobDone(done({name: 'x'.repeat(500)})).name.length, 60);
    assert.strictEqual(parseJobDone(done({name: 'a\nb\u0007c'})).name, 'a b c');
    assert.strictEqual(parseJobDone(done({name: '   '})).name, 'Object 3');
    assert.strictEqual(parseJobDone(done({name: 42})).name, 'Object 3');
  });
});

describe('payload validation', () => {
  test('refuses anything but a known kind, a boolean ok and whole-number ids', () => {
    const bad = [
      null,
      'track',
      [],
      done({kind: 'refine'}),
      done({kind: '__proto__'}),
      done({ok: 'yes'}),
      done({ok: undefined}),
      done({objectIds: []}),
      done({objectIds: '1,2'}),
      done({objectIds: [1.5]}),
      done({objectIds: [-1]}),
      done({objectIds: ['1']}),
      done({objectIds: [NaN]}),
      done({objectIds: Array.from({length: 257}, (_, i) => i)}),
    ];
    for (const b of bad) assert.strictEqual(parseJobDone(b), null, JSON.stringify(b));
    const {jobDone, Notification} = setup();
    for (const b of bad) assert.strictEqual(jobDone(b), false);
    assert.strictEqual(Notification.made.length, 0);
  });

  test('extra fields are dropped, never shown', () => {
    assert.deepStrictEqual(parseJobDone(done({title: 'pwned', body: 'pwned'})), {kind: 'track', ok: true, objectIds: [2, 0], name: 'Dog'});
  });
});
