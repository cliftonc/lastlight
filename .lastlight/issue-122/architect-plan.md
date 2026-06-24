# Problem Statement

The contributor documentation still references the legacy Hermes-based runtime and skill format rather than the current agentic-pi / pi-ai stack. In `CONTRIBUTING.md:3`, Last Light is described as being built on Hermes Agent, which conflicts with the runtime description in `README.md:12-14` (agentic-pi + pi-ai). The "Review Guidelines" bullet in `CONTRIBUTING.md:16` points to a non-existent `.hermes.md` file. The sample skill frontmatter in `CONTRIBUTING.md:24-41` uses a deprecated `metadata.hermes` block, contradicting the current frontmatter standard in `docs/agents/writing-skills.md:98-117`. Finally, `CONTRIBUTING.md:47` tells contributors to "Test your changes with a real Hermes session", which no longer matches how Last Light is run and tested.

# Summary of what needs to change

- Update `CONTRIBUTING.md` to describe the current runtime stack (agentic-pi + pi-ai with the TypeScript harness) instead of Hermes Agent.
- Replace the stale reference to `.hermes.md` with pointers to the actual review/triage docs under `docs/agents/`, especially `docs/agents/triage-labels.md`.
- Refresh the sample skill frontmatter to match the modern standard: `name` + `description` required, `version` and `tags` optional, no `metadata.hermes` block.
- Update the pull request testing guidance to refer to running a Last Light instance (e.g. via the CLI or dev server), not a "Hermes session".

# Files to modify — exhaustive manifest

## `CONTRIBUTING.md`

1. **Update runtime description (line 3)**
   - **Anchor:** `CONTRIBUTING.md:3`
   - **Current text:**
     - "Thanks for your interest in contributing! Last Light is an open-source GitHub maintenance agent built on [Hermes Agent](https://hermes-agent.nousresearch.com/)."
   - **Change:**
     - Replace the Hermes Agent reference with the same runtime stack described in `README.md:12-14`.
     - **Target text (adapted from README):**
       - "Thanks for your interest in contributing! Last Light is an open-source GitHub maintenance agent built on [agentic-pi](https://github.com/cliftonc/agentic-pi) (workflow phases) and [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) (in-process chat) with a lightweight TypeScript harness for webhook ingestion, cron scheduling, and process management."

2. **Fix review guidelines pointer (line 16)**
   - **Anchor:** `CONTRIBUTING.md:16`
   - **Current text:**
     - "- **Review Guidelines**: Better default review/triage rules in `.hermes.md`"
   - **Change:**
     - Point contributors at the real review/triage docs under `docs/agents/`, especially `triage-labels.md`.
     - **Target text:**
       - "- **Review & triage guidelines**: Better default review/triage rules in `docs/agents/triage-labels.md` and related docs under `docs/agents/`."

3. **Modernize sample skill frontmatter (lines 24–41)**
   - **Anchor:** `CONTRIBUTING.md:24-41`, `docs/agents/writing-skills.md:98-117`
   - **Current snippet:**
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
   - **Change:**
     - Align the example with the documented frontmatter standard in `docs/agents/writing-skills.md:115-117`:
       - `name` (kebab, ≤64) and `description` (≤1024, trigger-led) required.
       - `version` and `tags` optional.
       - No `metadata.hermes` block.
     - **Target snippet:**
       ```markdown
       ---
       name: my-skill
       description: One-line description (≤1024 chars, trigger-led)
       version: 1.0.0
       tags: [github, maintenance]
       ---

       # Skill Name

       ## When to Use
       ## Procedure
       ## Pitfalls
       ## Verification
       ```

4. **Update PR testing guidance (line 47)**
   - **Anchor:** `CONTRIBUTING.md:43-48`, `README.md:60-67`, `README.md:86-119` (CLI examples)
   - **Current bullet:**
     - "- Test your changes with a real Hermes session before submitting"
   - **Change:**
     - Rephrase to match how contributors actually run Last Light now: via the dev server and/or the `lastlight` CLI, independent of Hermes.
     - **Target bullet:**
       - "- Test your changes against a running Last Light instance (for example, via `npm run dev` and the `lastlight` CLI) before submitting"

# Commands

From `.lastlight/issue-122/guardrails-report.md`, the executor should use:

- **Tests:** `npm test`
- **Type checking / build:** `npm run build`

(These commands assume dependencies have been installed with `npm install` in the repo root.)

# Implementation approach

1. **Align runtime description in CONTRIBUTING**
   - Open `CONTRIBUTING.md` and update line 3 to describe the runtime as agentic-pi + pi-ai with the TypeScript harness, mirroring the wording from `README.md:12-14`.
   - Verify that the updated sentence accurately reflects the current architecture and links to the correct upstream projects.

2. **Point review guidelines to real docs**
   - Replace the `.hermes.md` reference at `CONTRIBUTING.md:16` with a pointer to `docs/agents/triage-labels.md` and related agent-docs.
   - Confirm that `docs/agents/triage-labels.md` exists and remains the canonical triage vocabulary reference (already documented in `docs/agents/writing-skills.md:110-113`).

3. **Update sample skill frontmatter to the modern standard**
   - In `CONTRIBUTING.md`, replace the YAML block at lines 24–33 with the new frontmatter example that:
     - Uses only `name`, `description`, `version`, and `tags` at the top level.
     - Describes `description` as trigger-led and ≤1024 chars.
     - Removes all `metadata.hermes` nesting.
   - Keep the rest of the skill body skeleton (`# Skill Name`, section headings) unchanged so existing contributor expectations stay familiar.
   - Cross-check against `docs/agents/writing-skills.md:115-117` to ensure terminology and constraints are consistent.

4. **Refresh PR testing guidance**
   - Edit the bullet list under `## Pull Requests` (`CONTRIBUTING.md:43-48`):
     - Replace the Hermes-session bullet with guidance to run `npm run dev` and/or use the `lastlight` CLI against a local instance before opening a PR.
   - Optionally add a brief parenthetical pointing to README sections that show how to run the dev server and CLI, if doing so improves clarity without introducing redundancy.

5. **Self-check for remaining Hermes-runtime references in CONTRIBUTING**
   - Scan the rest of `CONTRIBUTING.md` to confirm there are no other references implying Hermes is the underlying runtime or that `.hermes.md` exists.
   - Leave mentions of Hermes only where they are clearly about historical migration cruft in other docs (e.g., `docs/agents/writing-skills.md`), not about the current stack.

6. **Run verification commands**
   - Run `npm test` to ensure no tests fail unexpectedly (even though only docs changed, this guards against accidental repo drift or misconfigured scripts).
   - Run `npm run build` to confirm the TypeScript build still passes after the doc changes.

# Risks and edge cases

- **Contributor confusion about runtime stack:**
  - *Risk:* If the updated wording in `CONTRIBUTING.md:3` diverges from `README.md:12-14`, contributors may see conflicting descriptions of the runtime.
  - *Mitigation:* Keep `CONTRIBUTING.md` tightly aligned with README wording and verify both during review. Any future runtime changes should update both files together.

- **Doc references drifting again:**
  - *Risk:* Future edits might reintroduce Hermes-specific language or point to non-existent files.
  - *Mitigation:* Encourage reviewers to treat `docs/agents/writing-skills.md:98-117` and `README.md:12-14` as the single source of truth for skills and runtime; changes elsewhere should cross-reference those sections.

- **Runtime inputs / behaviour:**
  - This change is purely documentation; it does not alter runtime behaviour or introduce new inputs. There are **no new user inputs or API payloads** whose handling needs warn-and-skip / warn-and-surface semantics.
  - If future work extends this issue to code changes that touch user inputs, the implementation must explicitly specify, for each unsupported input case, whether to **warn-and-skip** (log or comment and omit action) or **warn-and-surface** (return a surfaced error or GitHub comment) rather than silently dropping it.

# Test strategy

- After making the documentation edits in `CONTRIBUTING.md`, run:
  - `npm test` — validate that the Vitest suite still passes and that the test harness is wired correctly.
  - `npm run build` — ensure the TypeScript build succeeds and there are no type errors introduced indirectly (even though this change is docs-only, this acts as a safety net).
- Optionally, perform a quick manual sanity check by opening `CONTRIBUTING.md` and `docs/agents/writing-skills.md` side by side to confirm the skill frontmatter example and runtime description are internally consistent.

# Estimated complexity

- **Complexity:** simple — single-file documentation update with no code-path or runtime changes, plus standard test and build verification.