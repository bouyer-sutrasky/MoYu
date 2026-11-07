import { describe, expect, it } from 'vitest';

import { taskModel, type TaskRow } from '../src/tasks';

function row(overrides: Partial<TaskRow>): TaskRow {
  return {
    id: 'task',
    conversationId: 'conversation',
    repositoryId: 'repository',
    state: 'running',
    upstreamTicketId: null,
    upstreamThreadId: null,
    baseBranch: 'main',
    baseCommit: null,
    modelId: 'local-test/local-test',
    modelReasoningEffort: null,
    executionMode: 'execute',
    question: null,
    questionMessageId: null,
    prUrl: null,
    prNumber: null,
    planRevision: null,
    stopRequestedAt: null,
    stoppedAt: null,
    stopEvidence: {},
    runtimeLeaseId: null,
    version: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe('taskModel', () => {
  it('omits a null reasoning effort so the strict Bridge model schema accepts it', () => {
    expect(taskModel(row({ modelReasoningEffort: null }))).toEqual({
      provider: 'local-test',
      model: 'local-test',
    });
    expect(JSON.stringify(taskModel(row({ modelReasoningEffort: null })))).not.toContain(
      'reasoningEffort',
    );
  });

  it('keeps an explicit reasoning effort and model identity', () => {
    expect(taskModel(row({ modelReasoningEffort: 'high' }))).toEqual({
      provider: 'local-test',
      model: 'local-test',
      reasoningEffort: 'high',
    });
  });
});
