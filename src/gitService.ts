import { execSync, spawnSync } from 'child_process';
import * as path from 'path';
import { Intent } from './intentParser';

export interface CommitEntry {
    hash: string;
    shortHash: string;
    date: string;
    author: string;
    message: string;
    action?: '+' | '-' | '~';
    lines?: string[];
}

export interface GitResult {
    intent: Intent;
    commits?: CommitEntry[];
    raw?: string;
    error?: string;
    repoRoot?: string;
    githubBaseUrl?: string;
    relativeFile?: string;
}

function getGitHubBaseUrl(repoRoot: string): string | undefined {
    try {
        const remote = execSync('git remote get-url origin', { cwd: repoRoot, encoding: 'utf8' }).trim();
        const ssh    = remote.match(/git@github\.com:(.+?)(?:\.git)?$/);
        const https  = remote.match(/https:\/\/github\.com\/(.+?)(?:\.git)?$/);
        const repo   = ssh?.[1] ?? https?.[1];
        return repo ? `https://github.com/${repo}` : undefined;
    } catch { return undefined; }
}

function findRepoRoot(filePath: string): string | undefined {
    try {
        const dir = path.dirname(filePath);
        return execSync('git rev-parse --show-toplevel', { cwd: dir, encoding: 'utf8' }).trim();
    } catch {
        return undefined;
    }
}

function getRelativePath(repoRoot: string, absPath: string): string {
    return path.relative(repoRoot, absPath).replace(/\\/g, '/');
}

function branchArg(branch?: string): string {
    if (!branch) return '--all';
    // Accept plain names like "rbkqa", auto-prefix with origin/
    if (branch.startsWith('origin/') || branch.startsWith('refs/')) return branch;
    return `origin/${branch}`;
}

function run(cmd: string, cwd: string): string {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, cwd });
}

// Safe version — passes args as an array, bypassing shell entirely.
// Use this whenever user-supplied strings (search terms) are in the args.
function runArgs(args: string[], cwd: string): string {
    const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, cwd });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(r.stderr || `git exited ${r.status}`);
    return r.stdout ?? '';
}

function parsePickaxeOutput(raw: string, searchString: string): CommitEntry[] {
    const commits: CommitEntry[] = [];
    let current: CommitEntry | null = null;
    const sl = searchString.toLowerCase();

    for (const line of raw.split('\n')) {
        if (line.startsWith('COMMIT_MARKER:')) {
            if (current) commits.push(current);
            const [hash, date, author, ...msg] = line.replace('COMMIT_MARKER:', '').split('|');
            current = {
                hash: hash.trim(),
                shortHash: hash.trim().slice(0, 10),
                date: date.trim(),
                author: author.trim(),
                message: msg.join('|').trim(),
                lines: [],
            };
            continue;
        }
        if (!current) continue;

        if (line.startsWith('+') && !line.startsWith('+++') && line.toLowerCase().includes(sl)) {
            current.lines!.push(`+ ${line.slice(1).trim()}`);
        }
        if (line.startsWith('-') && !line.startsWith('---') && line.toLowerCase().includes(sl)) {
            current.lines!.push(`- ${line.slice(1).trim()}`);
        }
    }
    if (current) commits.push(current);

    for (const c of commits) {
        const hasAdded   = c.lines!.some(l => l.startsWith('+'));
        const hasRemoved = c.lines!.some(l => l.startsWith('-'));
        c.action = hasAdded && hasRemoved ? '~' : hasAdded ? '+' : '-';
    }

    return commits;
}

function parseLogOutput(raw: string): CommitEntry[] {
    return raw
        .split('\n')
        .filter(l => l.trim())
        .map(line => {
            const [hash, date, author, ...msg] = line.split('|');
            return {
                hash: hash.trim(),
                shortHash: hash.trim().slice(0, 10),
                date: date.trim(),
                author: author.trim(),
                message: msg.join('|').trim(),
            };
        });
}

function fileHasString(hash: string, relFile: string, searchString: string, repoRoot: string): boolean {
    const r = spawnSync('git', ['show', `${hash}:${relFile}`],
        { encoding: 'utf8', cwd: repoRoot, maxBuffer: 5 * 1024 * 1024 });
    return (r.stdout ?? '').toLowerCase().includes(searchString.toLowerCase());
}

/**
 * Binary-search for hidden removal commits between consecutive ADD commits.
 * Copado conflict-resolution merge commits often remove lines but don't appear
 * in the standard pickaxe output. Binary search keeps git show calls to ~log2(N).
 */
function findHiddenRemovals(
    searchString: string,
    commits: CommitEntry[],
    branch: string,
    relFile: string,
    repoRoot: string,
): CommitEntry[] {
    // Work chronologically (oldest first)
    const chrono = [...commits].sort((a, b) => a.date < b.date ? -1 : 1);
    const result: CommitEntry[] = [];

    for (let i = 0; i < chrono.length - 1; i++) {
        const earlier = chrono[i];
        const later   = chrono[i + 1];
        // Only look for a removal between two consecutive ADDs
        if (earlier.action !== '+' || later.action !== '+') continue;

        // Get all commit hashes (+ metadata) touching this file between the two dates.
        // Newest first — we'll reverse below.
        const rangeArgs = [
            'log', '--full-history', branch,
            '--format=%H|%ad|%an|%s', '--date=format:%Y-%m-%d',
            `--after=${earlier.date}`, `--before=${later.date}`,
            '--', relFile,
        ];
        const rangeOut = runArgs(rangeArgs, repoRoot);
        const entries = rangeOut.split('\n').filter(l => l.trim()).map(line => {
            const [hash, date, author, ...msg] = line.split('|');
            return { hash: hash.trim(), date, author, message: msg.join('|').trim() };
        }).reverse(); // chronological order

        if (entries.length === 0) continue;

        // Binary search for the first commit where the string is absent.
        // Precondition: string IS present at 'earlier', absent at 'later'.
        let lo = 0, hi = entries.length - 1;

        // Quick sanity: if last entry still has the string, nothing to find here.
        if (fileHasString(entries[hi].hash, relFile, searchString, repoRoot)) continue;

        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (fileHasString(entries[mid].hash, relFile, searchString, repoRoot)) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }

        const e = entries[lo];
        result.push({
            hash:      e.hash,
            shortHash: e.hash.slice(0, 10),
            date:      e.date,
            author:    e.author,
            message:   e.message,
            action:    '-',
            lines:     [],
        });
    }

    return result;
}

export async function executeIntent(intent: Intent): Promise<GitResult> {
    if (!intent.filePath) {
        return { intent, error: 'No file selected. Open a file in the editor first.' };
    }

    const repoRoot = findRepoRoot(intent.filePath);
    if (!repoRoot) {
        return { intent, error: 'File is not inside a Git repository.' };
    }

    const relFile      = getRelativePath(repoRoot, intent.filePath);
    const githubBaseUrl = getGitHubBaseUrl(repoRoot);
    const mk = (extra: Omit<GitResult, 'intent' | 'repoRoot' | 'relativeFile' | 'githubBaseUrl'>): GitResult =>
        ({ intent, repoRoot, relativeFile: relFile, githubBaseUrl, ...extra });
    const err = (msg: string): GitResult => mk({ error: msg });
    const branch = branchArg(intent.branch);
    const logFmt = `--format="COMMIT_MARKER:%H|%ad|%an|%s" --date=format:"%Y-%m-%d"`;

    try {
        switch (intent.type) {

            case 'FIND_ADDED':
            case 'FIND_REMOVED':
            case 'FIND_BOTH':
            case 'SEARCH_ALL_BRANCHES': {
                if (!intent.searchString) {
                    return err('Could not detect what to search for. Try: "when was RAMP_EXIT_RBOB added"');
                }
                // Pass 1: pickaxe (no -m) — fast, finds direct commits correctly.
                const args = [
                    'log', `-S${intent.searchString}`,
                    '--full-history', branch, '-p',
                    '--format=COMMIT_MARKER:%H|%ad|%an|%s',
                    '--date=format:%Y-%m-%d',
                    '--', relFile,
                ];
                const raw  = runArgs(args, repoRoot);
                let commits = parsePickaxeOutput(raw, intent.searchString);

                // Pass 2: for FIND_BOTH/FIND_REMOVED, binary-search for removals hidden
                // inside Copado conflict-resolution merge commits (not caught by pickaxe alone).
                if (intent.type === 'FIND_BOTH' || intent.type === 'FIND_REMOVED') {
                    const hidden = findHiddenRemovals(intent.searchString, commits, branch, relFile, repoRoot);
                    commits = [...commits, ...hidden];
                    // Re-sort newest first
                    commits.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
                }

                if (intent.type === 'FIND_ADDED')   commits = commits.filter(c => c.action === '+');
                if (intent.type === 'FIND_REMOVED') commits = commits.filter(c => c.action === '-');

                return mk({ commits });
            }

            case 'FULL_HISTORY': {
                const cmd = `git log --full-history ${branch} ${logFmt} -- "${relFile}"`;
                const raw = run(cmd, repoRoot);
                const commits = parseLogOutput(raw.replace(/^"/, '').replace(/"$/, ''));
                return mk({ commits });
            }

            case 'RECENT_HISTORY': {
                const limit = intent.limit ?? 10;
                const cmd   = `git log --full-history ${branch} -${limit} ${logFmt} -- "${relFile}"`;
                const raw   = run(cmd, repoRoot);
                const commits = parseLogOutput(raw.replace(/^"/, '').replace(/"$/, ''));
                return mk({ commits });
            }

            case 'SHOW_COMMIT': {
                if (!intent.commitHash) {
                    return err('Could not extract a commit hash from your question.');
                }
                const raw = run(`git show ${intent.commitHash} -- "${relFile}"`, repoRoot);
                return mk({ raw });
            }

            case 'BLAME': {
                const raw = run(`git blame --date=short "${relFile}"`, repoRoot);
                return mk({ raw });
            }

            default:
                return err('Unknown intent.');
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { intent, error: msg.slice(0, 500) };
    }
}
