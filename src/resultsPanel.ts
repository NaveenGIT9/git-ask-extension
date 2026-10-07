import * as vscode from 'vscode';
import { GitResult, CommitEntry } from './gitService';
import { describeIntent } from './intentParser';

let panel: vscode.WebviewPanel | undefined;

function actionBadge(action?: string): string {
    if (action === '+') return `<span class="badge added">ADDED</span>`;
    if (action === '-') return `<span class="badge removed">REMOVED</span>`;
    if (action === '~') return `<span class="badge modified">MODIFIED</span>`;
    return '';
}

// "2026-10-06" -> "Oct 6th 2026" (display only; the ISO string stays as the sort key)
function formatDate(iso: string): string {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return iso;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = parseInt(m[3], 10);
    const month = months[parseInt(m[2], 10) - 1];
    if (!month || !day) return iso;
    const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th';
    return `${month} ${day}${suffix} ${m[1]}`;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderCommits(commits: CommitEntry[], githubBaseUrl?: string): string {
    if (commits.length === 0) {
        return `<div class="empty">No commits found matching your query.</div>`;
    }
    // Show oldest first so the timeline reads top→bottom: ADDED → REMOVED → RE-ADDED
    const ordered = [...commits].reverse();
    return ordered.map(c => {
        const commitUrl  = githubBaseUrl ? `${githubBaseUrl}/commit/${c.hash}` : '';
        const hashEl     = commitUrl
            ? `<a class="hash hash-link" data-url="${commitUrl}" title="Open on GitHub">${escapeHtml(c.shortHash)}</a>`
            : `<code class="hash">${escapeHtml(c.shortHash)}</code>`;
        const branchUrl = c.originBranch && githubBaseUrl
            ? `${githubBaseUrl}/tree/${c.originBranch.split('/').map(encodeURIComponent).join('/')}`
            : '';
        const branchEl = c.originBranch
            ? branchUrl
                ? `<a class="origin-branch branch-link" data-url="${branchUrl}" title="Open branch on GitHub"><span class="origin-label">origin:</span>${escapeHtml(c.originBranch)}</a>`
                : `<span class="origin-branch"><span class="origin-label">origin:</span>${escapeHtml(c.originBranch)}</span>`
            : '';
        const branchLink = (name: string): string => githubBaseUrl
            ? `<a class="origin-branch branch-link" data-url="${githubBaseUrl}/tree/${name.split('/').map(encodeURIComponent).join('/')}" title="Open branch on GitHub">${escapeHtml(name)}</a>`
            : `<span class="origin-branch">${escapeHtml(name)}</span>`;
        const whereEl = (c.mergeInto || c.mergeFrom)
            ? `<span class="where">${c.mergeInto ? `<span class="where-label">on</span>${branchLink(c.mergeInto)}` : ''}${c.mergeFrom ? `<span class="where-label">while merging</span>${branchLink(c.mergeFrom)}` : ''}</span>`
            : '';
        const mergeBadge = c.isAutoConflict
            ? `<span class="badge auto-conflict">⚠ auto-merge</span>`
            : c.isMerge
            ? `<span class="badge merge-badge">⇄ merge</span>`
            : '';
        const roleBadge = c.removalRole === 'dropped'
            ? `<span class="badge dropped-badge">✖ line lost here</span>`
            : c.removalRole === 'carried'
            ? `<span class="badge carried-badge">↳ carried removal in</span>`
            : '';
        const commitClass = c.removalRole === 'dropped'
            ? 'commit dropped-commit'
            : c.isAutoConflict ? 'commit conflict-commit' : 'commit';
        return `
        <div class="${commitClass}">
            <div class="commit-header">
                ${c.mergeStep === 'carried-over'
                    ? `<span class="badge carried-over-badge">↳ CARRIED OVER</span>`
                    : c.mergeStep === 'merged-in'
                    ? `<span class="badge merged-in-badge">⇄ MERGED IN</span>`
                    : actionBadge(c.action)}
                ${roleBadge}
                ${mergeBadge}
                <span class="date">${escapeHtml(formatDate(c.date))}</span>
                ${hashEl}
                <span class="author">${escapeHtml(c.author)}</span>
                ${branchEl}
                ${whereEl}
            </div>
            <div class="message">${escapeHtml(c.message)}</div>
            ${c.note ? `<div class="note">${escapeHtml(c.note)}</div>` : ''}
            ${c.lines && c.lines.length > 0 ? `
            <div class="diff-lines">
                ${c.lines.map(l => {
                    const cls = l.startsWith('+') ? 'diff-add' : 'diff-remove';
                    return `<div class="diff-line ${cls}"><code>${escapeHtml(l)}</code></div>`;
                }).join('')}
            </div>` : ''}
        </div>`;
    }).join('');
}

function buildHtml(result: GitResult, question: string, webview: vscode.Webview): string {
    void webview; // used for nonce in future; kept for API consistency
    const title    = describeIntent(result.intent);
    const file     = result.relativeFile ?? result.intent.filePath ?? 'unknown file';
    const count    = result.commits?.length ?? 0;
    const body     = result.error
        ? `<div class="error">⚠ ${escapeHtml(result.error)}</div>`
        : result.raw
            ? `<pre class="raw">${escapeHtml(result.raw.slice(0, 100_000))}</pre>`
            : renderCommits(result.commits ?? [], result.githubBaseUrl);

    // The block the user asked about, shown above the results; lines missing from that block on the branch are marked.
    const blockLines = (result.intent.blockLines && result.intent.blockLines.length > 1)
        ? result.intent.blockLines
        : (result.intent.lineContext && result.intent.lineContext.lines.length > 1 ? result.intent.lineContext.lines : undefined);
    const missing = new Set(result.missingLines ?? []);
    const SHOWN = 40;
    const blockHtml = blockLines
        ? `<div class="traced-block">
             <div class="traced-block-title">Block you asked about (${blockLines.length} lines)${missing.size ? ' — <span class="miss-key">highlighted</span> = missing from this block on the branch' : ''}</div>
             <pre>${blockLines.slice(0, SHOWN).map(l => `<span class="${missing.has(l) ? 'tb-line tb-missing' : 'tb-line'}">${escapeHtml(l)}</span>`).join('\n')}${blockLines.length > SHOWN ? `\n… ${blockLines.length - SHOWN} more lines` : ''}</pre>
           </div>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Git Ask</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: 13px;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    padding: 16px;
  }
  .header { margin-bottom: 16px; }
  .traced-block { margin: 0 0 16px; border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px; background: var(--vscode-textBlockQuote-background, #2a2a2a); }
  .traced-block-title { padding: 6px 10px; font-size: 11px; color: var(--vscode-descriptionForeground, #9d9d9d); border-bottom: 1px solid var(--vscode-panel-border, #444); }
  .traced-block pre { margin: 0; padding: 8px 10px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; overflow-x: auto; }
  .tb-line { display: inline-block; min-width: 100%; }
  .tb-missing { background: rgba(244, 71, 71, 0.25); color: #f48771; }
  .miss-key { background: rgba(244, 71, 71, 0.25); color: #f48771; padding: 0 4px; border-radius: 2px; }
  .scope-note { margin-top: 6px; font-size: 12px; color: var(--vscode-descriptionForeground, #9d9d9d); }
  .question {
    font-size: 15px;
    font-weight: 600;
    color: var(--vscode-textLink-activeForeground, #4fc1ff);
    margin-bottom: 4px;
  }
  .subtitle { color: var(--vscode-descriptionForeground, #858585); font-size: 12px; }
  .file-path {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #858585);
    margin-top: 4px;
    word-break: break-all;
  }
  .count-bar {
    margin: 12px 0;
    padding: 6px 10px;
    background: var(--vscode-badge-background, #4d4d4d);
    border-radius: 4px;
    font-size: 12px;
    display: inline-block;
  }
  .commit {
    border-left: 3px solid var(--vscode-panel-border, #444);
    padding: 10px 12px;
    margin-bottom: 10px;
    background: var(--vscode-editorWidget-background, #252526);
    border-radius: 4px;
  }
  .commit.conflict-commit {
    border-left-color: #c98000;
    background: color-mix(in srgb, var(--vscode-editorWidget-background, #252526) 92%, #c98000 8%);
  }
  .commit.dropped-commit {
    border-left-color: #f47474;
    background: color-mix(in srgb, var(--vscode-editorWidget-background, #252526) 90%, #f47474 10%);
  }
  .where { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; }
  .where-label { color: var(--vscode-descriptionForeground, #858585); font-style: italic; }
  .note {
    margin-top: 6px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #b0b0b0);
    border-left: 2px solid #7a5000;
    padding-left: 8px;
  }
  .merge-legend {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #858585);
    margin: 6px 0 14px;
    display: flex;
    gap: 14px;
    align-items: center;
    flex-wrap: wrap;
  }
  .commit-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .badge.added         { background: #1a472a; color: #4ec94e; }
  .badge.removed       { background: #4a1a1a; color: #f47474; }
  .badge.modified      { background: #3a3a1a; color: #e5c07b; }
  .badge.auto-conflict { background: #4a2e00; color: #e0a000; border: 1px solid #7a5000; }
  .badge.merge-badge   { background: #1a2a4a; color: #5a9aff; border: 1px solid #2a4a7a; }
  .badge.dropped-badge { background: #5a1a1a; color: #ff8a8a; border: 1px solid #a03a3a; }
  .badge.merged-in-badge   { background: #14323f; color: #4fc1ff; border: 1px solid #1f5a73; }
  .badge.carried-over-badge { background: #2a2a4a; color: #a9a9ff; border: 1px solid #4a4a8a; }
  .badge.carried-badge { background: #4a2e00; color: #e0a000; border: 1px solid #7a5000; }
  .date   { color: var(--vscode-descriptionForeground, #858585); font-size: 12px; }
  .hash   { background: var(--vscode-textBlockQuote-background, #333); padding: 1px 5px; border-radius: 3px; font-size: 11px; color: #ce9178; font-family: monospace; }
  a.hash-link { text-decoration: none; cursor: pointer; border-bottom: 1px dashed #ce9178; }
  a.hash-link:hover { background: #555; border-bottom-style: solid; }
  .author { font-weight: 500; color: var(--vscode-textLink-foreground, #3794ff); }
  .origin-branch { font-size: 10px; font-family: monospace; background: #2a3a2a; color: #7ec87e; border: 1px solid #3a5a3a; border-radius: 3px; padding: 1px 6px; display: inline-flex; align-items: center; gap: 4px; }
  a.branch-link { text-decoration: none; cursor: pointer; }
  a.branch-link:hover { background: #3a5a3a; border-color: #5a8a5a; }
  .origin-label { color: #5a8a5a; font-weight: 700; font-style: italic; }
  .message { font-size: 13px; color: var(--vscode-editor-foreground, #d4d4d4); margin-top: 2px; }
  .diff-lines { margin-top: 8px; }
  .diff-line { padding: 2px 0; font-size: 12px; }
  .diff-add  code { color: #4ec94e; }
  .diff-remove code { color: #f47474; }
  .raw { white-space: pre-wrap; word-break: break-all; font-size: 12px; line-height: 1.6; overflow: auto; max-height: 80vh; }
  .error { color: #f47474; padding: 12px; background: #4a1a1a; border-radius: 4px; }
  .empty { color: var(--vscode-descriptionForeground, #858585); padding: 12px; }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border, #444); margin: 12px 0; }
  .tip { font-size: 11px; color: var(--vscode-descriptionForeground, #858585); margin-top: 16px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border, #444); }
  .tip code { background: var(--vscode-textBlockQuote-background, #333); padding: 1px 4px; border-radius: 2px; }
</style>
</head>
<body>
  <div class="header">
    <div class="question">💬 "${escapeHtml(question)}"</div>
    <div class="subtitle">${escapeHtml(title)}</div>
    <div class="file-path">📄 ${escapeHtml(file)}</div>
    ${result.scopeNote ? `<div class="scope-note">${escapeHtml(result.scopeNote)}</div>` : ''}
  </div>

  ${blockHtml}

  ${result.commits !== undefined && !result.error
    ? `<div class="count-bar">${count} commit${count !== 1 ? 's' : ''} found</div>`
    : ''}

  ${result.intent.type === 'FULL_HISTORY' ? `
  <div class="merge-legend">
    <span><span class="badge merge-badge">⇄ merge</span> = merge commit</span>
    <span><span class="badge auto-conflict">⚠ auto-merge</span> = auto conflict resolution — may have silently dropped changes</span>
  </div>` : ''}

  ${body}

  <div class="tip">
    💡 <strong>Tip:</strong> Select any text in the editor → right-click → <code>Git Ask: Trace this line's lifecycle</code> to skip typing entirely.
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.hash-link, .branch-link').forEach(el => {
      el.addEventListener('click', () => {
        vscode.postMessage({ command: 'openLink', url: el.getAttribute('data-url') });
      });
    });
  </script>
</body>
</html>`;
}

export function showResults(context: vscode.ExtensionContext, result: GitResult, question: string): void {
    if (!panel) {
        panel = vscode.window.createWebviewPanel(
            'gitask',
            'Git Ask',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
        panel.webview.onDidReceiveMessage(
            (msg: { command: string; url: string }) => {
                if (msg.command === 'openLink' && msg.url) {
                    vscode.env.openExternal(vscode.Uri.parse(msg.url));
                }
            },
            undefined,
            context.subscriptions
        );
    } else {
        panel.reveal(vscode.ViewColumn.Beside, true);
    }
    panel.webview.html = buildHtml(result, question, panel.webview);
}
