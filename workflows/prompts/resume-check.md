Check if a build cycle already exists for this issue.

SETUP (git is pre-configured, you are in a sandbox workspace):
1. Try: git clone --branch {{branch}} https://github.com/{{owner}}/{{repo}}.git && cd {{repo}}
   If the branch doesn't exist, output "current_phase: none" and stop.

2. If the branch exists, check for {{issueDir}}/status.md
   If it exists, read it and output its contents.
   If it doesn't exist, output "current_phase: none"

OUTPUT: The contents of status.md, or "current_phase: none" if no prior work exists.
Do NOT modify any files. This is a read-only check.
