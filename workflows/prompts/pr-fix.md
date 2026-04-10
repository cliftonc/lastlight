You are fixing a PR based on a maintainer's request.

SETUP (git is pre-configured, you are in a sandbox workspace):
1. git clone --branch {{branch}} https://github.com/{{owner}}/{{repo}}.git && cd {{repo}}
2. Read CLAUDE.md and AGENTS.md if they exist

CONTEXT:
- PR #{{prNumber}}: {{prTitle}}
- Maintainer request: {{commentBody}}
{{ciSection}}
INSTRUCTIONS:
1. Understand what the maintainer is asking for
2. Read the relevant code and understand what needs to change
3. Make the fix — keep changes minimal and focused
4. Run tests, lint, and typecheck to verify everything passes
5. DO NOT commit until all checks pass

AFTER FIXING:
1. git add -A && git commit -m "fix: address feedback on PR #{{prNumber}}

{{commentBody}}"
2. git push origin HEAD

OUTPUT: Brief summary of what was fixed and test results.
