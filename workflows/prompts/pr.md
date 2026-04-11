Create a pull request for the work on branch {{branch}}.

Use the MCP tool create_pull_request with the following:
- owner: {{owner}}
- repo: {{repo}}
- head: {{branch}}
- base: main
- title: A concise title describing the change (reference #{{issueNumber}})
- body: A markdown body that includes EXACTLY these sections in order:

  Closes #{{issueNumber}}

  ## Summary
  (3-6 bullet points describing what changed)

  ## Planning and execution docs
  - [Guardrails report]({{branchUrl guardrails-report.md}})
  - [Architect plan]({{branchUrl architect-plan.md}})
  - [Executor summary]({{branchUrl executor-summary.md}})
  - [Reviewer verdict]({{branchUrl reviewer-verdict.md}})
  - [Status]({{branchUrl status.md}})

  Before adding each link above, run `ls -1 {{issueDir}}/`
  on the branch and OMIT any line whose file doesn't exist on disk. Use the
  exact full https URLs above as written — do NOT shorten to relative paths,
  they will not render in the PR description.

  ## Test results
  (paste the actual test/lint/typecheck output from executor-summary.md){{#if !review.approved}}

Note: There are unresolved reviewer issues after {{review.cycles}} fix cycles. See reviewer-verdict.md on the branch.{{/if}}

Then use add_issue_comment on issue #{{issueNumber}} to post the PR link.

Update status.md: current_phase = complete, add pr_number.
git add .lastlight/ && git commit -m "status: PR created for #{{issueNumber}}" && git push origin HEAD

OUTPUT: The PR number and URL.
