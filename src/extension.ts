import * as vscode from 'vscode';
import { executeIntent } from './gitService';
import { showResults } from './resultsPanel';
import { Intent } from './intentParser';

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

async function traceLifecycle(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
    const filePath = getActiveFilePath(uri);
    if (!filePath) {
        vscode.window.showErrorMessage('Git Ask: Open a file in the editor first.');
        return;
    }

    // Use selected text; if none, let user type it
    let searchText = getSelectedText();

    if (!searchText) {
        searchText = await vscode.window.showInputBox({
            title:          'Git Ask: Trace Line Lifecycle',
            prompt:         'Paste or type the line/string to trace',
            placeHolder:    'e.g.  MAX( NULLVALUE(ACV__c, 0) - NULLVALUE(RAMP_EXIT_RBOB__c, 0), 0)',
            ignoreFocusOut: true,
        });
    }

    if (!searchText?.trim()) return;

    const branch = await vscode.window.showInputBox({
        title:          'Git Ask: Branch',
        prompt:         'Which branch to trace? (leave blank for all branches)',
        value:          'rbkqa',
        ignoreFocusOut: true,
    });

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Git Ask: tracing...', cancellable: false },
        async () => {
            const intent: Intent = {
                type:             'FIND_BOTH',
                searchString:     searchText!.trim(),
                branch:           branch?.trim() || undefined,
                filePath,
                originalQuestion: searchText!.trim(),
            };
            const result = await executeIntent(intent);
            showResults(context, result, searchText!.trim());
        }
    );
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
    );
}

export function deactivate(): void {}
