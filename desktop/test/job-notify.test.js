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
    close() {
      this.closed = true;
      this.handlers.close?.();
    }
    click() {
      this.handlers.click();
    }
  }
  FakeNotification.made = made;
  return FakeNotification;
}

function fakeWindow({minimized = false} = {}) {
  const calls = [];
  const sent = [];
  return {
    calls,
    sent,
    isMinimized: () => minimized,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    webContents: {send(channel, payload) {
      calls.push('send');
      sent.push({channel, payload});
    }},
  };
}

/** `focused`: which app window has focus ('main', 'sam3', or null for another app). */
function setup({on = true, win = fakeWindow(), focused = null} = {}) {
  const Notification = fakeNotificationClass();
  let enabled = on;
  const clock = {t: 1000000};
  const jobDone = createJobNotifier({Notification, enabled: () => enabled, getWindow: () => win, appFocused: () => focused != null, now: () => clock.t});
  return {jobDone, Notification, win, clock, setEnabled: v => (enabled = v)};
}

const done = (extra = {}) => ({kind: 'track', ok: true, engine: 'sam3', objectIds: [2, 0], name: 'Dog', ...extra});

describe('when it notifies', () => {
  test('off by default: only "notifyJobDone": true turns it on', () => {
    for (const settings of [{}, null, {notifyJobDone: 'true'}, {notifyJobDone: 1}, {notifyJobDone: false}]) {
      assert.strictEqual(notifyEnabled(settings), false, JSON.stringify(settings));
    }
    assert.strictEqual(notifyEnabled({notifyJobDone: true}), true);
  });

  test('nothing while the window is focused', () => {
    const {jobDone, Notification} = setup({focused: 'main'});
    assert.strictEqual(jobDone(done()), false);
    assert.strictEqual(Notification.made.length, 0);
  });

  test('nothing while another sam-ui window (the SAM 3 setup) is focused', () => {
    const {jobDone, Notification} = setup({focused: 'sam3'});
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
    assert.deepStrictEqual(win.sent, [{channel: 'jobs:open', payload: {engine: 'sam3', objectIds: [2, 0]}}]);
  });

  test('restores a minimized window first', () => {
    const {jobDone, Notification, win} = setup({win: fakeWindow({minimized: true})});
    jobDone(done());
    Notification.made[0].click();
    assert.deepStrictEqual(win.calls, ['restore', 'show', 'focus', 'send']);
  });
});

describe('one at a time', () => {
  test('the one on screen is kept until it is clicked', () => {
    const {jobDone, Notification} = setup();
    jobDone(done());
    assert.strictEqual(jobDone.showing(), Notification.made[0]);
    Notification.made[0].click();
    assert.strictEqual(jobDone.showing(), null);
  });

  test('or closed', () => {
    const {jobDone, Notification} = setup();
    jobDone(done());
    Notification.made[0].close();
    assert.strictEqual(jobDone.showing(), null);
  });

  test('a flood shows one, and a later job replaces it', () => {
    const {jobDone, Notification, clock} = setup();
    let shown = 0;
    for (let i = 0; i < 100; i++) {
      shown += jobDone(done({objectIds: [i]})) ? 1 : 0;
      clock.t += 10;
    }
    assert.strictEqual(shown, 1);
    assert.strictEqual(Notification.made.length, 1);
    clock.t += 5000;
    assert.strictEqual(jobDone(done({ok: false})), true);
    assert.strictEqual(Notification.made.length, 2);
    assert.ok(Notification.made[0].closed); // replaced, not piled up
    assert.strictEqual(jobDone.showing(), Notification.made[1]);
  });

  test('a failure right after a shown finish still shows', () => {
    const {jobDone, Notification, clock} = setup();
    assert.strictEqual(jobDone(done()), true);
    clock.t += 3000;
    assert.strictEqual(jobDone(done({ok: false})), true);
    assert.strictEqual(Notification.made.length, 2);
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
      done({engine: undefined}),
      done({engine: 'SAM 3'}),
      done({engine: 'x'.repeat(33)}),
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
    assert.deepStrictEqual(parseJobDone(done({title: 'pwned', body: 'pwned'})), {kind: 'track', ok: true, engine: 'sam3', objectIds: [2, 0], name: 'Dog'});
  });
});
