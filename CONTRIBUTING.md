# Contributing to Last Light

Thanks for your interest in contributing! Last Light is an open-source GitHub maintenance agent built on [Hermes Agent](https://hermes-agent.nousresearch.com/).

## Getting Started

1. Fork the repository
2. Clone your fork
3. Follow the setup instructions in [README.md](README.md)
4. Create a branch for your changes

## What to Contribute

- **Skills**: New agent skills in `skills/` — see existing ones for the format
- **MCP Server**: Improvements to the GitHub App MCP server in `mcp-github-app/`
- **Review Guidelines**: Better default review/triage rules in `.hermes.md`
- **Documentation**: README improvements, examples, guides
- **Bug Fixes**: If something isn't working as expected

## Skill Format

Skills live in `skills/<name>/SKILL.md` with YAML frontmatter and markdown body:

```markdown
---
name: my-skill
description: One-line description
version: 1.0.0
metadata:
  hermes:
    tags: [github, code]
    category: maintenance
---

# Skill Name

## When to Use
## Procedure
## Pitfalls
## Verification
```

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Update the README if you change setup steps or add features
- Test your changes with a real Hermes session before submitting
- Don't commit secrets (`.env`, `.pem` files, tokens)

## Code Style

- Shell scripts: use `set -euo pipefail`, quote variables
- JavaScript (MCP server): ES modules, async/await, no unnecessary dependencies
- Skills: clear step-by-step procedures, include pitfalls and verification

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
