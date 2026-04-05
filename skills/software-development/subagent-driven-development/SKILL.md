---
name: subagent-driven-development
description: Use when executing implementation plans with independent tasks. Dispatches fresh delegate_task per task with two-stage review (spec compliance then code quality).
version: 1.1.0
author: Hermes Agent (adapted from obra/superpowers)
license: MIT
metadata:
  hermes:
    tags: [delegation, subagent, implementation, workflow, parallel]
    related_skills: [plan, requesting-code-review, test-driven-development]
---

# Subagent-Driven Development

## Overview

Execute implementation plans by dispatching fresh subagents per task with systematic two-stage review.

**Core principle:** Fresh subagent per task + two-stage review (spec then quality) = high quality, fast iteration.

## GitHub-First Gate

Before starting any implementation work, ensure a **GitHub issue** exists to track it:
- If an issue already exists (e.g. from a webhook event), use it.
- If the request came from Discord, Slack, or CLI with no linked issue, **create one first**
  in the appropriate managed repo (see `.hermes.md`). Use the request as the issue body.
- Post progress updates (plan, task completion, review verdicts) as comments on the issue.
- **Never start coding without a tracking issue.** The issue is the authorisation gate and audit trail.

## Guardrails Check

Before dispatching the first task, run the `assure-guardrails` skill on the target repo.
This verifies that test framework, linting, and type checking are in place. If any are
missing (verdict: BLOCKED), create a guardrails issue, fix the foundations first, then
resume. The build cycle depends on these: TDD needs tests, requesting-code-review needs
lint/typecheck, the Reviewer needs tests to run.

## When to Use

Use this skill when:
- You have an implementation plan (from plan skill or user requirements)
- Tasks are mostly independent
- Quality and spec compliance are important
- You want automated review between tasks

**vs. manual execution:**
- Fresh context per task (no confusion from accumulated state)
- Automated review process catches issues early
- Consistent quality checks across all tasks
- Subagents can ask questions before starting work

## The Process

### 1. Read and Parse Plan

Read the plan file. Extract ALL tasks with their full text and context upfront. Create a todo list:

```python
# Read the plan
read_file("docs/plans/feature-plan.md")

# Create todo list with all tasks
todo([
    {"id": "task-1", "content": "Create User model with email field", "status": "pending"},
    {"id": "task-2", "content": "Add password hashing utility", "status": "pending"},
    {"id": "task-3", "content": "Create login endpoint", "status": "pending"},
])
```

**Key:** Read the plan ONCE. Extract everything. Don't make subagents read the plan file — provide the full task text directly in context.

### 2. Per-Task Workflow

For EACH task in the plan:

#### Step 1: Dispatch Implementer Subagent

Use `delegate_task` with complete context and explicit role identity:

```python
delegate_task(
    goal="Implement Task 1: Create User model with email and password_hash fields",
    context="""
    ROLE: You are the EXECUTOR. You implement precisely what the task spec
    requires, no more, no less. Keep going until the task is fully resolved.
    Do not claim completion without fresh verification output (test results,
    build output). Prefer the smallest viable diff. Do not broaden scope
    unless correctness requires it.

    TASK FROM PLAN:
    - Create: src/models/user.py
    - Add User class with email (str) and password_hash (str) fields
    - Use bcrypt for password hashing
    - Include __repr__ for debugging

    FOLLOW TDD:
    1. Write failing test in tests/models/test_user.py
    2. Run: pytest tests/models/test_user.py -v (verify FAIL)
    3. Write minimal implementation
    4. Run: pytest tests/models/test_user.py -v (verify PASS)
    5. Run: pytest tests/ -q (verify no regressions)
    6. Commit with Lore format:
       git add -A && git commit -m "feat: add User model with password hashing

       Tested: pytest tests/models/test_user.py -> all passing
       Scope-risk: low"

    PROJECT CONTEXT:
    - Python 3.11, Flask app in src/app.py
    - Existing models in src/models/
    - Tests use pytest, run from project root
    - bcrypt already in requirements.txt
    """,
    toolsets=['terminal', 'file']
)
```

#### Step 2: Dispatch Spec Compliance Reviewer

After the implementer completes, verify against the original spec:

```python
delegate_task(
    goal="Review if implementation matches the spec from the plan",
    context="""
    ROLE: You are the SPEC REVIEWER. You verify implementations against
    specifications. You do not fix code — you report gaps. Every finding
    must cite file:line evidence. You have no shared context with the
    implementer. Judge only by the spec and the code.

    ORIGINAL TASK SPEC:
    - Create src/models/user.py with User class
    - Fields: email (str), password_hash (str)
    - Use bcrypt for password hashing
    - Include __repr__

    CHECK:
    - [ ] All requirements from spec implemented?
    - [ ] File paths match spec?
    - [ ] Function signatures match spec?
    - [ ] Behavior matches expected?
    - [ ] Nothing extra added (no scope creep)?

    OUTPUT: PASS or list of specific spec gaps to fix (with file:line refs).
    """,
    toolsets=['file']
)
```

**If spec issues found:** Fix gaps, then re-run spec review. Continue only when spec-compliant.

#### Step 3: Dispatch Code Quality Reviewer

After spec compliance passes:

```python
delegate_task(
    goal="Review code quality for Task 1 implementation",
    context="""
    ROLE: You are the CODE REVIEWER. Independent quality verification.
    You have no shared context with the implementer. Review only the code,
    not the process. Every finding must cite file:line evidence. You do not
    fix code — you report issues.

    FILES TO REVIEW:
    - src/models/user.py
    - tests/models/test_user.py

    CHECK:
    - [ ] Follows project conventions and style?
    - [ ] Proper error handling?
    - [ ] Clear variable/function names?
    - [ ] Adequate test coverage?
    - [ ] No obvious bugs or missed edge cases?
    - [ ] No security issues?

    OUTPUT FORMAT:
    - Critical Issues: [must fix before proceeding] (with file:line refs)
    - Important Issues: [should fix]
    - Minor Issues: [optional]
    - Verdict: APPROVED or REQUEST_CHANGES
    """,
    toolsets=['file']
)
```

**If quality issues found:** Fix issues, re-review. Continue only when approved.

#### Step 4: Mark Complete

```python
todo([{"id": "task-1", "content": "Create User model with email field", "status": "completed"}], merge=True)
```

### 3. Final Review

After ALL tasks are complete, dispatch a final integration reviewer:

```python
delegate_task(
    goal="Review the entire implementation for consistency and integration issues",
    context="""
    ROLE: You are the CODE REVIEWER performing integration review of
    THIS BRANCH'S CHANGES ONLY. You have no shared context with the
    implementers. You do not fix code — you report issues.

    SCOPE — CRITICAL:
    Review ONLY the files changed on this branch vs main. Get the scope first:
      git diff main --name-only   # list of changed files
      git diff main               # the actual changes

    Do NOT review unchanged files. Do NOT flag pre-existing issues.
    You may read unchanged files for context only if needed to understand
    a specific change.

    CHECK (on changed files only):
    - Do the changes work together as a cohesive whole?
    - Any inconsistencies between the tasks just completed?
    - All tests passing? (run them — do not assume)
    - Ready for merge?

    OUTPUT: APPROVED or REQUEST_CHANGES with specific issues (file:line refs).
    """,
    toolsets=['terminal', 'file']
)
```

### 3b. Architect Completion Gate

After the integration reviewer passes, dispatch an architect for a final completeness check.
This is the "persistent until verified complete" gate — it catches gaps that individual task
reviews miss because they lack the full picture.

```python
delegate_task(
    goal="Architect completion verification — is this truly done?",
    context="""
    ROLE: You are the ARCHITECT. Read-only verification. You do not fix
    code — you assess completeness and architectural coherence.

    All tasks from the plan are implemented and have passed both spec
    compliance and code quality review.

    Verify the ENTIRE implementation against the original requirements:
    - Does the full implementation satisfy the original requirements?
    - Any gaps between what was planned and what was built?
    - Any architectural concerns with how the pieces fit together?
    - Are there loose ends, missing error paths, or untested edge cases?
    - Would you ship this? If not, what specifically is missing?

    ORIGINAL PLAN:
    [INSERT FULL PLAN CONTENT]

    OUTPUT FORMAT:
    - Verdict: COMPLETE or INCOMPLETE
    - If INCOMPLETE: specific gaps with file:line references
    - If COMPLETE: one-sentence confirmation
    """,
    toolsets=['terminal', 'file']
)
```

**If INCOMPLETE:** Create new tasks for the identified gaps, execute them through the
same per-task workflow (Steps 2-3), and re-run the architect gate. Maximum 2 cycles —
after that, report remaining gaps to the user.

### 4. Verify and Commit

```bash
# Run full test suite
pytest tests/ -q

# Review all changes
git diff --stat

# Final commit if needed
git add -A && git commit -m "feat: complete [feature name] implementation"
```

## Task Granularity

**Each task = 2-5 minutes of focused work.**

**Too big:**
- "Implement user authentication system"

**Right size:**
- "Create User model with email and password fields"
- "Add password hashing function"
- "Create login endpoint"
- "Add JWT token generation"
- "Create registration endpoint"

## Red Flags — Never Do These

- Start implementation without a plan
- Skip reviews (spec compliance OR code quality)
- Proceed with unfixed critical/important issues
- Dispatch multiple implementation subagents for tasks that touch the same files
- Make subagent read the plan file (provide full text in context instead)
- Skip scene-setting context (subagent needs to understand where the task fits)
- Ignore subagent questions (answer before letting them proceed)
- Accept "close enough" on spec compliance
- Skip review loops (reviewer found issues → implementer fixes → review again)
- Let implementer self-review replace actual review (both are needed)
- **Start code quality review before spec compliance is PASS** (wrong order)
- Move to next task while either review has open issues

## Handling Issues

### If Subagent Asks Questions

- Answer clearly and completely
- Provide additional context if needed
- Don't rush them into implementation

### If Reviewer Finds Issues

- Implementer subagent (or a new one) fixes them
- Reviewer reviews again
- Repeat until approved
- Don't skip the re-review

### If Subagent Fails a Task

- Dispatch a new fix subagent with specific instructions about what went wrong
- Don't try to fix manually in the controller session (context pollution)

## Efficiency Notes

**Why fresh subagent per task:**
- Prevents context pollution from accumulated state
- Each subagent gets clean, focused context
- No confusion from prior tasks' code or reasoning

**Why two-stage review:**
- Spec review catches under/over-building early
- Quality review ensures the implementation is well-built
- Catches issues before they compound across tasks

**Cost trade-off:**
- More subagent invocations (implementer + 2 reviewers per task)
- But catches issues early (cheaper than debugging compounded problems later)

## Integration with Other Skills

### With plan

This skill EXECUTES plans created by the plan skill:
1. User requirements → plan → implementation plan
2. Implementation plan → subagent-driven-development → working code

### With test-driven-development

Implementer subagents should follow TDD:
1. Write failing test first
2. Implement minimal code
3. Verify test passes
4. Commit

Include TDD instructions in every implementer context.

### With requesting-code-review

The two-stage review process IS the code review. For final integration review, use the requesting-code-review skill's review dimensions.

### With systematic-debugging

If a subagent encounters bugs during implementation:
1. Follow systematic-debugging process
2. Find root cause before fixing
3. Write regression test
4. Resume implementation

## Example Workflow

```
[Read plan: docs/plans/auth-feature.md]
[Create todo list with 5 tasks]

--- Task 1: Create User model ---
[Dispatch implementer subagent]
  Implementer: "Should email be unique?"
  You: "Yes, email must be unique"
  Implementer: Implemented, 3/3 tests passing, committed.

[Dispatch spec reviewer]
  Spec reviewer: ✅ PASS — all requirements met

[Dispatch quality reviewer]
  Quality reviewer: ✅ APPROVED — clean code, good tests

[Mark Task 1 complete]

--- Task 2: Password hashing ---
[Dispatch implementer subagent]
  Implementer: No questions, implemented, 5/5 tests passing.

[Dispatch spec reviewer]
  Spec reviewer: ❌ Missing: password strength validation (spec says "min 8 chars")

[Implementer fixes]
  Implementer: Added validation, 7/7 tests passing.

[Dispatch spec reviewer again]
  Spec reviewer: ✅ PASS

[Dispatch quality reviewer]
  Quality reviewer: Important: Magic number 8, extract to constant
  Implementer: Extracted MIN_PASSWORD_LENGTH constant
  Quality reviewer: ✅ APPROVED

[Mark Task 2 complete]

... (continue for all tasks)

[After all tasks: dispatch final integration reviewer]
[Run full test suite: all passing]
[Done!]
```

## Remember

```
Fresh subagent per task
Two-stage review every time
Spec compliance FIRST
Code quality SECOND
Never skip reviews
Catch issues early
```

**Quality is not an accident. It's the result of systematic process.**
