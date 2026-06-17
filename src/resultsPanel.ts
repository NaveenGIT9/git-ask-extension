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
        return `
        <div class="commit">
            <div class="commit-header">
                ${actionBadge(c.action)}
                <span class="date">${escapeHtml(c.date)}</span>
                ${hashEl}
                <span class="author">${escapeHtml(c.author)}</span>
            </div>
            <div class="message">${escapeHtml(c.message)}</div>
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
  .badge.added   { background: #1a472a; color: #4ec94e; }
  .badge.removed { background: #4a1a1a; color: #f47474; }
  .badge.modified{ background: #3a3a1a; color: #e5c07b; }
  .date   { color: var(--vscode-descriptionForeground, #858585); font-size: 12px; }
  .hash   { background: var(--vscode-textBlockQuote-background, #333); padding: 1px 5px; border-radius: 3px; font-size: 11px; color: #ce9178; font-family: monospace; }
  a.hash-link { text-decoration: none; cursor: pointer; border-bottom: 1px dashed #ce9178; }
  a.hash-link:hover { background: #555; border-bottom-style: solid; }
  .author { font-weight: 500; color: var(--vscode-textLink-foreground, #3794ff); }
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
  </div>

  ${result.commits !== undefined && !result.error
    ? `<div class="count-bar">${count} commit${count !== 1 ? 's' : ''} found</div>`
    : ''}

  ${body}

  <div class="tip">
    💡 <strong>Tip:</strong> Select any text in the editor → right-click → <code>Git Ask: Trace this line's lifecycle</code> to skip typing entirely.
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.hash-link').forEach(el => {
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
