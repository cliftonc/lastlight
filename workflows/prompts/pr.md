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
{{docLinks}}

  Before adding each link above, run `ls -1 {{issueDir}}/`
  on the branch and OMIT any line whose file doesn't exist on disk. Use the
  exact full https URLs above as written — do NOT shorten to relative paths,
  they will not render in the PR description.

  ## Test results
  (paste the actual test/lint/typecheck output from executor-summary.md){{reviewerNote}}

Then use add_issue_comment on issue #{{issueNumber}} to post the PR link.

Update status.md: current_phase = complete, add pr_number.
git add .lastlight/ && git commit -m "status: PR created for #{{issueNumber}}" && git push origin HEAD

OUTPUT: The PR number and URL.
