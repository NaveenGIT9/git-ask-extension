import * as vscode from 'vscode';
import { executeIntent } from './gitService';
import { showResults } from './resultsPanel';
import { Intent, LineContext } from './intentParser';

function getActiveFilePath(uri?: vscode.Uri): string | undefined {
    if (uri) return uri.fsPath;
    return vscode.window.activeTextEditor?.document.uri.fsPath;
}

function getSelectedText(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const sel = editor.selection;
    if (!sel.isEmpty) {
        const text = editor.document.getText(sel).trim();
        // Multi-line selection: git pickaxe needs exact whitespace match, so use
        // the longest single line from the selection as the search string instead.
        if (text.includes('\n')) {
            const best = text.split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0)
                .sort((a, b) => b.length - a.length)[0];
            return best || undefined;
        }
        return text;
    }
    // No selection — use current line content (trimmed)
    return editor.document.lineAt(sel.active.line).text.trim() || undefined;
}

// The line(s) the user selected (or the cursor line), plus two neighbours either side, so the same lines can be
// found again in another revision and traced by position. Undefined when there is nothing usable to trace.
function getLineContext(filePath: string): LineContext | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.fsPath !== filePath) return undefined;
    const sel = editor.selection;
    const first = sel.start.line;
    // A selection that ends at column 0 of the next line does not include that line.
    const last = !sel.isEmpty && sel.end.character === 0 && sel.end.line > first ? sel.end.line - 1 : sel.end.line;
    if (last - first >= 200) return undefined;
    const doc = editor.document;
    const trimmed = (n: number): string => doc.lineAt(n).text.trim();
    const lines: string[] = [];
    for (let n = first; n <= last; n++) lines.push(trimmed(n));
    if (lines.every(l => l === '')) return undefined;
    const before: string[] = [];
    for (let n = Math.max(0, first - 2); n < first; n++) before.push(trimmed(n));
    const after: string[] = [];
    for (let n = last + 1; n <= Math.min(doc.lineCount - 1, last + 2); n++) after.push(trimmed(n));
    return { lines, before, after, approxLine: first + 1 };
}

async function traceLifecycle(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
    const filePath = getActiveFilePath(uri);
    if (!filePath) {
        vscode.window.showErrorMessage('Git Ask: Open a file in the editor first.');
        return;
    }

    // Use selected text; if none, let user type it
    let searchText = getSelectedText();
    // A line taken from the editor is traced by its position; typed text can only be searched for.
    const lineContext = searchText ? getLineContext(filePath) : undefined;

    if (!searchText) {
        searchText = await vscode.window.showInputBox({
            title:          'Git Ask: Trace Line Lifecycle',
            prompt:         'Paste or type the line/string to trace',
            placeHolder:    'e.g.  MAX( NULLVALUE(ACV__c, 0) - NULLVALUE(RAMP_EXIT_RBOB__c, 0), 0)',
            ignoreFocusOut: true,
        });
    }

    if (!searchText?.trim()) return;

    await askBranchAndTrace(context, filePath, searchText.trim(), lineContext);
}

async function askBranchAndTrace(context: vscode.ExtensionContext, filePath: string, searchText: string, lineContext?: LineContext): Promise<void> {
    const branch = await vscode.window.showInputBox({
        title:          'Git Ask: Branch',
        prompt:         'Which branch to trace? (leave blank for all branches)',
        value:          'rbkqa',
        ignoreFocusOut: true,
    });
    if (branch === undefined) return;   // cancelled

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Git Ask: tracing...', cancellable: false },
        async () => {
            const intent: Intent = {
                type:             lineContext ? 'LINE_HISTORY' : 'FIND_BOTH',
                lineContext,
                searchString:     searchText,
                branch:           branch.trim() || undefined,
                filePath,
                originalQuestion: searchText,
            };
            const result = await executeIntent(intent);
            showResults(context, result, searchText);
        }
    );
}

// For a line that has been removed: it cannot be selected in the editor, so the text is pasted instead.
// If the clipboard already holds the line (or a block of lines), offer those lines to pick from.
async function traceRemovedLine(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
    const filePath = getActiveFilePath(uri);
    if (!filePath) {
        vscode.window.showErrorMessage('Git Ask: Open a file (or pick one in the Explorer) first.');
        return;
    }

    const clipboard = (await vscode.env.clipboard.readText()).trim();
    const clipLines = clipboard.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

    const TYPE_MANUALLY = '$(edit) Type or paste a different line...';
    let searchText: string | undefined;
    let prefill = clipLines.length === 1 ? clipLines[0] : '';

    if (clipLines.length > 1) {
        const picked = await vscode.window.showQuickPick(
            [...clipLines.map(l => ({ label: l })), { label: TYPE_MANUALLY, alwaysShow: true }],
            {
                title:          'Git Ask: which line from your clipboard did you want to trace?',
                placeHolder:    'Pick the line that was removed (a longer, more unique line gives better results)',
                ignoreFocusOut: true,
            }
        );
        if (!picked) return;
        if (picked.label === TYPE_MANUALLY) prefill = '';
        else searchText = picked.label;
    }

    if (!searchText) {
        searchText = await vscode.window.showInputBox({
            title:          'Git Ask: Trace a line that is no longer in the file',
            prompt:         'Paste the line (or a unique part of it) that was removed',
            placeHolder:    'e.g.  OpportunityObjectTriggerHelper.setMSPDealType(newOppObj, AccountMapTrgInsert);',
            value:          prefill,
            ignoreFocusOut: true,
        });
    }
    if (!searchText?.trim()) return;

    await askBranchAndTrace(context, filePath, searchText.trim());
}

async function fullHistoryCommand(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
    const filePath = getActiveFilePath(uri);
    if (!filePath) {
        vscode.window.showErrorMessage('Git Ask: Open a file first.');
        return;
    }

    const branch = await vscode.window.showInputBox({
        title:          'Git Ask: Full History',
        prompt:         'Branch (leave blank for all branches)',
        placeHolder:    'e.g. rbkqa',
        ignoreFocusOut: true,
    });

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Git Ask: loading history...', cancellable: false },
        async () => {
            const intent: Intent = {
                type:             'FULL_HISTORY',
                branch:           branch?.trim() || undefined,
                filePath,
                originalQuestion: 'show full history',
            };
            const result = await executeIntent(intent);
            showResults(context, result, `Full history${branch ? ` on ${branch}` : ' (all branches)'}`);
        }
    );
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('gitask.trace',
            (uri?: vscode.Uri) => traceLifecycle(context, uri)
        ),
        vscode.commands.registerCommand('gitask.fullHistory',
            (uri?: vscode.Uri) => fullHistoryCommand(context, uri)
        ),
        vscode.commands.registerCommand('gitask.traceRemoved',
            (uri?: vscode.Uri) => traceRemovedLine(context, uri)
        ),
    );
}

export function deactivate(): void {}
