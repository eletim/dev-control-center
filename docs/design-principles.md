# Design principles

Dev Control Center is a small local dashboard for registered development projects. These principles govern its behavior and future changes.

1. **Show observed state.** Running means a DCC-managed process group is active. Stopped includes completed commands and does not describe processes started elsewhere. Display unavailable Git or output information explicitly.
2. **Keep actions scoped to a registered project.** Start Commands use the project's configured directory and command. Git actions operate on that project's repository. Do not expose arbitrary shell or Git command execution through the dashboard.
3. **Protect existing work.** Refuse branch switches and fast-forward updates when the working tree is dirty. Require confirmation before removing worktrees, recheck their state, and never force removal of a dirty, locked, main, or registered worktree.
4. **Make background refresh safe for interaction.** Refresh visible state periodically and after actions, while preserving in-progress form input and focus. Associate retained output with the managed run that produced it.
5. **Keep the interface responsive as projects grow.** Avoid repeated repository-wide work for projects sharing a repository during the same refresh. Keep status and error messages specific enough to guide the next action.
