// Tests the env-var branch added to server.js's launch block. We don't
// actually start Camoufox — we exercise the decision function in
// isolation by importing the helper module added in Step 6.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseLaunch } from '../lib/launch-branch.js';

test('chooseLaunch returns "launch" when env unset', () => {
  assert.equal(chooseLaunch({}), 'launch');
});

test('chooseLaunch returns "launch" when env empty string', () => {
  assert.equal(chooseLaunch({ CAMOFOX_USER_DATA_DIR: '' }), 'launch');
});

test('chooseLaunch returns "persistent" when env set to a path', () => {
  assert.equal(
    chooseLaunch({ CAMOFOX_USER_DATA_DIR: '/tmp/firefox-borrow-abc' }),
    'persistent'
  );
});

test('chooseLaunch rejects paths outside /tmp/firefox-borrow- prefix', () => {
  assert.throws(
    () => chooseLaunch({ CAMOFOX_USER_DATA_DIR: '/Users/dave/Library/Application Support/Firefox/Profiles/abc' }),
    /must start with \/tmp\/firefox-borrow-/
  );
  assert.throws(
    () => chooseLaunch({ CAMOFOX_USER_DATA_DIR: '/tmp/something-else' }),
    /must start with \/tmp\/firefox-borrow-/
  );
});

test('chooseLaunch path must be absolute', () => {
  assert.throws(
    () => chooseLaunch({ CAMOFOX_USER_DATA_DIR: 'relative/path' }),
    /must start with \//
  );
});
