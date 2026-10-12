# Git Ask

A VS Code extension for answering "what happened to this line?" in a Git repository - especially when a line **disappeared** because of a merge or an auto conflict resolution, which VS Code's File History and most history views hide.

Select a line in a file, right-click, and see when it was added, when it was removed, and **which merge lost it**.

## Install

The packaged extension is in this repo: **`vscode-git-ask-1.0.0.vsix`**.

1. Download `vscode-git-ask-1.0.0.vsix` from this repo.
2. In VS Code open Extensions (`Ctrl+Shift+X`) → the `...` menu → **Install from VSIX...** → choose the file.
3. Run **Developer: Reload Window**.

Or from a terminal:

```
code --install-extension vscode-git-ask-1.0.0.vsix --force
```

**Requirements:** VS Code 1.85+, and `git` installed and on your PATH. The file you trace must be inside a git repository with its history fetched (a shallow clone will miss older commits). Git Ask does not depend on GitLens or any other extension.

## Commands

Right-click in the editor (or on a file in the Explorer) and look for the **Git Ask** entries:

| Command | What it does |
|---|---|
| **Git Ask: Trace this line's lifecycle (when added / removed)** | Traces the selected line(s), or the line your cursor is on. **One line whose text appears only once in the file** is traced by its content: when that exact text was added, merged in, removed and re-added (line numbers do not matter). **A block** (several lines) is traced by position, so only commits that changed those lines are shown. **A line that appears several times** in the file (for example `<fields>NAME</fields>`, which sits in many related lists) cannot say which copy you mean, so Git Ask asks you to select the whole block instead and, in XML files, offers **Expand to the enclosing block**. If the line or block is not in the file on the branch you pick (for example it was removed), the result says so. Text you type yourself is searched as text. Shortcut: `Ctrl+Shift+G` then `Ctrl+Shift+T`. |
| **Git Ask: Trace a line/block which is no longer present** | For a line or block that has been removed (or changed) and so cannot be selected: paste it, or take it from your clipboard. A block is compared with the same block on the branch you pick, and the result shows which of its lines are missing and which commits added and lost them. |

Each trace asks which branch to look at, in a searchable list that shows **local and remote branches side by side**: a local branch is shown as `rbkuat`, a remote one as `origin/rbkuat`, and the description next to each says `local` or `remote` (the checked-out branch is marked). Typing `rbk` lists both, and you can trace either. The result header says which one was read, for example `origin/rbkuat (remote)` or `rbkuat (local)`. A remote branch is only as current as your last `git fetch`, and a local branch can be behind its remote, so the two can give different answers. "All branches" traces the branch you have checked out. Text you type that is not in the list is resolved the way git does it: `rbkuat` is the local branch, `origin/rbkuat` the remote one, and `HEAD`, tags and commit hashes work too.

## Reading the results

- **ADDED / REMOVED / MODIFIED** - what the commit did to the traced text.
- **LINE LOST HERE** - the merge that actually lost the line. A note explains why, for example: the line existed on one side of the merge, but the other branch's copy of the file predates it, and the merge result ended up with that older copy (typically Copado's auto conflict resolution keeping the feature branch's version). The row shows **on `<branch>` while merging `<branch>`**: the mistake happened on the first branch, not in the second branch's own commits.
- **CARRIED REMOVAL IN** - a merge that brought an earlier removal into the branch you are tracing (for example a promotion branch merged into `rbkqa`).
- **AUTO-MERGE** - the merge message says "auto conflict resolution".
- **origin: `<branch>`** - the feature or promotion branch that delivered the commit into the traced branch. For a commit made directly on a promotion branch, that promotion branch is shown.

If a line was removed by a merge and added back later, the trace shows all of it: added, lost, carried in, added again.

## Why it finds things File History does not

`git log -- <file>` (what File History and the Timeline use) simplifies merges: when a merge's version of the file equals one parent, it follows only that parent and drops the commits on the other side. In repositories with many Copado-style merges that hides most of the story. Git Ask searches without that pruning and then inspects each merge's parents, so it can say which merge dropped a line and from which side.

## Limits

- It matches the text you give it (case-sensitive, including spacing). A line that was reformatted will not match the old text.
- For a merge it looks at the first two parents.
- Branch and "origin" labels are read from merge messages in the form `Merging <source> to <target>` / `Merging <source> into <target>` (the Copado style). Other merge messages are still traced, just without branch names.

## Build from source

```
npm install
npm run compile
npx vsce package
```
