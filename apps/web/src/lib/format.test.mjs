import assert from 'node:assert/strict';
import test from 'node:test';

import { formatElapsed, repositoryActivationLabel, repositoryRuntimeLabel } from './format.ts';

test('formatElapsed reports real measured durations without estimates', () => {
  assert.equal(formatElapsed(null), null);
  assert.equal(formatElapsed(undefined), null);
  assert.equal(formatElapsed(Number.NaN), null);
  assert.equal(formatElapsed(-1), null);
  assert.equal(formatElapsed(400), '不到 1 秒');
  assert.equal(formatElapsed(12_000), '12 秒');
  assert.equal(formatElapsed(65_000), '1 分 5 秒');
  assert.equal(formatElapsed(3_600_000), '1 小时');
  assert.equal(formatElapsed(3_900_000), '1 小时 5 分');
});

test('repositoryActivationLabel distinguishes queue, preparation, start and failure', () => {
  const activation = (phase) => ({
    phase,
    requestedAt: null,
    onlineAt: null,
    elapsedMs: null,
    readyMs: null,
    detail: null,
    retryAction: null,
  });
  assert.equal(repositoryActivationLabel(activation('queued')), '切换中 · 等待在线名额');
  assert.equal(repositoryActivationLabel(activation('preparing')), '切换中 · 仓库准备中');
  assert.equal(repositoryActivationLabel(activation('starting')), '切换中 · 启动中');
  assert.equal(repositoryActivationLabel(activation('failed')), '切换失败');
  assert.equal(repositoryActivationLabel(activation('ready')), null);
  assert.equal(repositoryActivationLabel(activation('idle')), null);
  assert.equal(repositoryActivationLabel(null), null);
});

test('repositoryRuntimeLabel keeps the process lifecycle label', () => {
  assert.equal(repositoryRuntimeLabel({ state: 'starting' }), '启动中');
  assert.equal(
    repositoryRuntimeLabel({ state: 'sleeping', reasonCode: 'capacity_wait' }),
    '排队中',
  );
  assert.equal(repositoryRuntimeLabel(null), '状态未知');
});
