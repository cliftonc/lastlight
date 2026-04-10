import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventEnvelope } from '../connectors/types.js';

// Mock the classifier before importing router
vi.mock('./classifier.js', () => ({
  classifyComment: vi.fn().mockResolvedValue('action'),
}));

import { routeEvent } from './router.js';
import { classifyComment } from './classifier.js';

const mockClassifyComment = vi.mocked(classifyComment);

/** Helper: build a minimal EventEnvelope */
function makeEnvelope(overrides: Partial<EventEnvelope>): EventEnvelope {
  return {
    id: 'test-id',
    source: 'github',
    type: 'issue.opened',
    repo: 'cliftonc/drizzle-cube',
    sender: 'octocat',
    senderIsBot: false,
    body: '',
    raw: {},
    reply: vi.fn().mockResolvedValue(undefined),
    timestamp: new Date(),
    ...overrides,
  };
}

describe('routeEvent — issue events', () => {
  it('routes issue.opened to issue-triage', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'issue.opened', issueNumber: 1, title: 'Bug', labels: [] }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('issue-triage');
      expect(result.context.reopened).toBeUndefined();
    }
  });

  it('routes issue.reopened to issue-triage with reopened: true', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'issue.reopened', issueNumber: 2, title: 'Bug' }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('issue-triage');
      expect(result.context.reopened).toBe(true);
    }
  });
});

describe('routeEvent — PR events', () => {
  it('routes pr.opened to pr-review', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'pr.opened', prNumber: 5, title: 'Add feature', labels: [] }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('pr-review');
    }
  });
});

describe('routeEvent — comment.created', () => {
  beforeEach(() => {
    mockClassifyComment.mockResolvedValue('action');
  });

  it('ignores comment without bot mention', async () => {
    const result = await routeEvent(makeEnvelope({
      type: 'comment.created',
      body: 'This is a regular comment',
    }));
    expect(result.action).toBe('ignore');
  });

  it('returns polite-decline for non-maintainer with bot mention', async () => {
    const result = await routeEvent(makeEnvelope({
      type: 'comment.created',
      body: '@last-light please fix this',
      authorAssociation: 'CONTRIBUTOR',
    }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('polite-decline');
    }
  });

  it('returns polite-decline for NONE association', async () => {
    const result = await routeEvent(makeEnvelope({
      type: 'comment.created',
      body: '@last-light please help',
      authorAssociation: 'NONE',
    }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('polite-decline');
    }
  });

  it('routes maintainer build intent on issue to github-orchestrator', async () => {
    mockClassifyComment.mockResolvedValue('build');
    const result = await routeEvent(makeEnvelope({
      type: 'comment.created',
      body: '@last-light implement this feature',
      authorAssociation: 'OWNER',
      issueNumber: 10,
    }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('github-orchestrator');
    }
  });

  it('routes maintainer action intent on issue to issue-comment', async () => {
    mockClassifyComment.mockResolvedValue('action');
    const result = await routeEvent(makeEnvelope({
      type: 'comment.created',
      body: '@last-light please close this issue',
      authorAssociation: 'MEMBER',
      issueNumber: 10,
    }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('issue-comment');
    }
  });

  it('routes maintainer build intent on PR to pr-fix', async () => {
    mockClassifyComment.mockResolvedValue('build');
    const result = await routeEvent(makeEnvelope({
      type: 'comment.created',
      body: '@last-light fix the failing tests',
      authorAssociation: 'COLLABORATOR',
      prNumber: 5,
    }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('pr-fix');
    }
  });

  it('routes maintainer action intent on PR to issue-comment', async () => {
    mockClassifyComment.mockResolvedValue('action');
    const result = await routeEvent(makeEnvelope({
      type: 'comment.created',
      body: '@last-light please approve this',
      authorAssociation: 'OWNER',
      prNumber: 5,
    }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('issue-comment');
    }
  });
});

describe('routeEvent — message events', () => {
  it('routes /new to chat-reset', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'message', body: '/new' }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('chat-reset');
    }
  });

  it('routes /reset to chat-reset', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'message', body: '/reset' }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('chat-reset');
    }
  });

  it('routes /build with managed repo to github-orchestrator', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'message', body: '/build cliftonc/drizzle-cube#42' }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('github-orchestrator');
      expect(result.context.repo).toBe('cliftonc/drizzle-cube');
      expect(result.context.issueNumber).toBe(42);
    }
  });

  it('routes /build with unmanaged repo to reply with error', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'message', body: '/build unknown/repo#1' }));
    expect(result.action).toBe('reply');
    if (result.action === 'reply') {
      expect(result.message).toContain('unknown/repo');
    }
  });

  it('routes /triage with managed repo to issue-triage', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'message', body: '/triage cliftonc/drizby' }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('issue-triage');
    }
  });

  it('routes /review with managed repo to pr-review', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'message', body: '/review cliftonc/lastlight' }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('pr-review');
    }
  });

  it('routes /status to status-report', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'message', body: '/status' }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('status-report');
    }
  });

  it('routes plain text to chat', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'message', body: 'Hello there!' }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('chat');
    }
  });
});

describe('routeEvent — approval commands in comment.created', () => {
  it('routes @last-light approve to approval-response with approved decision', async () => {
    const result = await routeEvent(makeEnvelope({
      type: 'comment.created',
      body: '@last-light approve',
      authorAssociation: 'OWNER',
      issueNumber: 10,
      repo: 'cliftonc/drizzle-cube',
    }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('approval-response');
      expect(result.context.decision).toBe('approved');
      expect(result.context.issueNumber).toBe(10);
      expect(result.context.repo).toBe('cliftonc/drizzle-cube');
    }
  });

  it('routes @last-light reject with reason to approval-response with rejected decision', async () => {
    const result = await routeEvent(makeEnvelope({
      type: 'comment.created',
      body: '@last-light reject plan needs more detail',
      authorAssociation: 'OWNER',
      issueNumber: 10,
    }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('approval-response');
      expect(result.context.decision).toBe('rejected');
      expect(result.context.reason).toBe('plan needs more detail');
    }
  });

  it('routes @last-light reject without reason', async () => {
    const result = await routeEvent(makeEnvelope({
      type: 'comment.created',
      body: '@last-light reject',
      authorAssociation: 'MEMBER',
      issueNumber: 5,
    }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('approval-response');
      expect(result.context.decision).toBe('rejected');
    }
  });

  it('does not route approval for non-maintainer — falls through to polite-decline', async () => {
    const result = await routeEvent(makeEnvelope({
      type: 'comment.created',
      body: '@last-light approve',
      authorAssociation: 'NONE',
      issueNumber: 10,
    }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('polite-decline');
    }
  });
});

describe('routeEvent — approval commands in message events', () => {
  it('routes /approve to approval-response with approved decision', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'message', body: '/approve' }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('approval-response');
      expect(result.context.decision).toBe('approved');
    }
  });

  it('routes /approve with workflow ID', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'message', body: '/approve abc-123' }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('approval-response');
      expect(result.context.decision).toBe('approved');
      expect(result.context.workflowRunId).toBe('abc-123');
    }
  });

  it('routes /reject to approval-response with rejected decision', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'message', body: '/reject' }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('approval-response');
      expect(result.context.decision).toBe('rejected');
    }
  });

  it('routes /reject with workflow ID and reason', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'message', body: '/reject abc-123 too risky' }));
    expect(result.action).toBe('skill');
    if (result.action === 'skill') {
      expect(result.skill).toBe('approval-response');
      expect(result.context.decision).toBe('rejected');
      expect(result.context.workflowRunId).toBe('abc-123');
      expect(result.context.reason).toBe('too risky');
    }
  });
});

describe('routeEvent — unhandled events', () => {
  it('ignores unknown event types', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'pr_review.submitted' }));
    expect(result.action).toBe('ignore');
  });

  it('ignores pr_review_comment.created', async () => {
    const result = await routeEvent(makeEnvelope({ type: 'pr_review_comment.created' }));
    expect(result.action).toBe('ignore');
  });
});
