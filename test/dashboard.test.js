import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, describeGit, requestJson } from '../public/app.js';

test('describes available and unavailable Git state explicitly', () => {
  assert.deepEqual(describeGit(null), {
    repository: false,
    summary: 'Git metadata unavailable.',
  });
  assert.deepEqual(describeGit({ isRepository: false }), {
    repository: false,
    summary: 'Not a Git repository.',
  });
  assert.deepEqual(describeGit({
    isRepository: true,
    branch: null,
    clean: null,
    remote: 'origin/main',
    ahead: null,
    behind: null,
  }), {
    repository: true,
    branch: 'Detached or unavailable',
    worktree: 'Unavailable',
    upstream: 'origin/main',
    divergence: 'Unavailable',
  });
});

test('requestJson preserves backend refusals and handles unavailable responses', async () => {
  await assert.rejects(
    requestJson('/action', {}, async () => ({
      ok: false,
      status: 409,
      json: async () => ({ message: 'Git working tree must be clean.' }),
    })),
    (error) => error instanceof ApiError
      && error.status === 409
      && error.message === 'Git working tree must be clean.',
  );

  await assert.rejects(
    requestJson('/action', {}, async () => { throw new Error('offline'); }),
    { message: 'Could not reach Dev Control Center.', status: 0 },
  );
});
