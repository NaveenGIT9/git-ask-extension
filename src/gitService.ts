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
    originBranch?: string;
    isMerge?: boolean;
    isAutoConflict?: boolean;
    // Set only on the commits that explain why the line is gone from the branch tip:
    //   'dropped' = the commit that actually lost the line
    //   'carried' = a merge that brought an earlier removal into the queried branch
    removalRole?: 'dropped' | 'carried';
    note?: string;
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

/**
 * Determine which branch a commit originally came from.
 *
 * Strategy: walk FORWARD from the commit to the query branch using --ancestry-path --merges.
 * git log --ancestry-path A..B shows only commits that are on the path from A to B.
 * Filtering to merge commits gives us the Copado "Merging X to Y" chain.
 * The OLDEST (last in git-log output, which is newest-first) is the first merge that
 * introduced the commit — its SOURCE (X) is the feature/promotion branch we want.
 *
 * Example: feature/US-0006812 → promotion/P08615 → rbkqa
 *   ancestry-path merges: ["Merging promotion/P08615 into rbkqa...", "Merging feature/US-0006812 to promotion/P08615"]
 *   Oldest = "Merging feature/US-0006812 to promotion/P08615" → source = feature/US-0006812 ✓
 *
 * For a direct commit on a promotion branch (no feature branch):
 *   ancestry-path merges: ["Merging promotion/P12686 into rbkqa..."]
 *   Oldest = only entry → source = promotion/P12686 ✓
 */
function getOriginBranch(hash: string, repoRoot: string, queryBranch: string): string | undefined {
    try {
        // Resolve a concrete target ref (--ancestry-path needs a specific ref, not --all)
        let targetRef = queryBranch !== '--all' ? queryBranch : '';
        if (!targetRef) {
            try {
                targetRef = runArgs(['rev-parse', '--abbrev-ref', 'origin/HEAD'], repoRoot).trim();
            } catch {
                targetRef = 'origin/master';
            }
        }

        const raw = runArgs(
            ['log', '--ancestry-path', '--merges', '--format=%s', `${hash}..${targetRef}`],
            repoRoot
        );
        const msgs = raw.split('\n').map(l => l.trim()).filter(Boolean);
        if (msgs.length === 0) return undefined;

        // Last entry = oldest merge = the one that first introduced hash to this line
        const oldest = msgs[msgs.length - 1];
        const match = oldest.match(/Merging (.+?) (?:to|into) /i);
        if (match) return match[1].trim();
    } catch { /* non-fatal */ }
    return undefined;
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
                shortHash: hash.trim().slice(0, 7),
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
                shortHash: hash.trim().slice(0, 7),
                date: date.trim(),
                author: author.trim(),
                message: msg.join('|').trim(),
            };
        });
}

// Parses output from `git log -m --format=COMMIT_MARKER:%H|%P|%ad|%an|%s ...`.
// -m causes each merge commit to appear once per parent, so we deduplicate by hash.
// %P (parent hashes, space-separated) lets us tag merge commits and auto-conflict merges.
function parseLogOutputWithMerges(raw: string): CommitEntry[] {
    const seen = new Set<string>();
    const commits: CommitEntry[] = [];
    for (const line of raw.split('\n')) {
        if (!line.startsWith('COMMIT_MARKER:')) continue;
        const data = line.slice('COMMIT_MARKER:'.length);
        const [hash, parentsRaw, date, author, ...msgParts] = data.split('|');
        const h = hash.trim();
        if (!h || seen.has(h)) continue;
        seen.add(h);
        const parents = parentsRaw.trim().split(/\s+/).filter(Boolean);
        const message = msgParts.join('|').trim();
        const isMerge = parents.length > 1;
        commits.push({
            hash: h,
            shortHash: h.slice(0, 7),
            date: date.trim(),
            author: author.trim(),
            message,
            isMerge,
            isAutoConflict: isMerge && message.toLowerCase().includes('auto conflict'),
        });
    }
    return commits;
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
            shortHash: e.hash.slice(0, 7),
            date:      e.date,
            author:    e.author,
            message:   e.message,
            action:    '-',
            lines:     [],
        });
    }

    return result;
}

interface CommitInfo {
    hash: string;
    parents: string[];
    date: string;
    author: string;
    message: string;
}

function commitInfo(hash: string, repoRoot: string): CommitInfo {
    const out = runArgs(
        ['show', '-s', '--format=%H|%P|%ad|%an|%s', '--date=format:%Y-%m-%d', hash],
        repoRoot
    ).trim();
    const [h, parentsRaw, date, author, ...msg] = out.split('|');
    return {
        hash:    h.trim(),
        parents: parentsRaw.trim().split(/\s+/).filter(Boolean),
        date:    date.trim(),
        author:  author.trim(),
        message: msg.join('|').trim(),
    };
}

// "Merging feature/X to promotion/Y ..." -> the merge is created on Y (first parent = Y's old tip),
// X is the second parent.
function parseMergeMessage(message: string): { src?: string; dst?: string } {
    const m = message.match(/Merging (\S+) (?:to|into) (\S+)/i);
    return m ? { src: m[1], dst: m[2] } : {};
}

function mergeBase(a: string, b: string, repoRoot: string): string | undefined {
    try {
        return runArgs(['merge-base', a, b], repoRoot).split('\n')[0].trim() || undefined;
    } catch { return undefined; }
}

// Commits (newest first) on the first-parent line of `range` that changed how many times the
// string occurs in the file. With --first-parent a merge is compared with its FIRST parent only,
// so a merge that silently dropped the line shows up here (plain `git log -S` hides merges).
function firstParentPickaxe(range: string, searchString: string, relFile: string, repoRoot: string): string[] {
    const out = runArgs(
        ['log', '--first-parent', `-S${searchString}`, range, '--format=%H', '--', relFile],
        repoRoot
    );
    return out.split('\n').map(l => l.trim()).filter(Boolean);
}

function chainEntry(info: CommitInfo, role: 'dropped' | 'carried', note: string): CommitEntry {
    const isMerge = info.parents.length > 1;
    return {
        hash:           info.hash,
        shortHash:      info.hash.slice(0, 7),
        date:           info.date,
        author:         info.author,
        message:        info.message,
        action:         '-',
        lines:          [],
        isMerge,
        isAutoConflict: isMerge && info.message.toLowerCase().includes('auto conflict'),
        removalRole:    role,
        note,
        // For these commits the branch that matters is the one named in the merge message
        // ("Merging <src> to <dst>"), not the next merge on the way to the queried branch.
        originBranch:   isMerge ? parseMergeMessage(info.message).src : undefined,
    };
}

/**
 * When the searched line is no longer in the file at the branch tip, explain WHY.
 *
 * Walks the branch's first-parent history to the commit where the line vanished, then, if that is a
 * merge, inspects its two parents:
 *   - base had the line and the other side removed it  -> this merge only CARRIED the removal in;
 *     descend into that side to find the real removal.
 *   - base never had the line, one side did, merge lost it -> THIS merge dropped it (typical for
 *     Copado "auto conflict resolution" keeping the feature branch's older copy of the file).
 * Returns the chain newest-first, e.g. [carried merge, dropping merge].
 */
function traceRemovalChain(searchString: string, branch: string, relFile: string, repoRoot: string): CommitEntry[] {
    const cache = new Map<string, boolean>();
    const has = (hash: string): boolean => {
        let v = cache.get(hash);
        if (v === undefined) { v = fileHasString(hash, relFile, searchString, repoRoot); cache.set(hash, v); }
        return v;
    };

    const tip = branch === '--all' ? 'HEAD' : branch;
    if (has(tip)) return [];   // the line is still there - nothing to explain

    const removalIn = (range: string): string | undefined =>
        firstParentPickaxe(range, searchString, relFile, repoRoot).find(h => !has(h));

    const locate = (hash: string, depth: number): CommitEntry[] => {
        const info = commitInfo(hash, repoRoot);
        if (info.parents.length < 2 || depth >= 6) {
            return [chainEntry(info, 'dropped', 'This commit removed the line.')];
        }

        const [pA, pB] = info.parents;
        const { src, dst } = parseMergeMessage(info.message);
        const hasA = has(pA);
        const hasB = has(pB);

        if (hasA && hasB) {
            return [chainEntry(info, 'dropped',
                'Both parents still had the line but this merge result does not: it was dropped while resolving conflicts in this merge.')];
        }
        if (!hasA && !hasB) {
            return [chainEntry(info, 'dropped', 'The line was already gone on both sides of this merge.')];
        }

        const pHas = hasA ? pA : pB;
        const pNo  = hasA ? pB : pA;
        // pB is the merged-in branch (src); pA is the branch the merge was made on (dst).
        const lackingBranch = pNo === pB ? src : dst;
        const base = mergeBase(pHas, pNo, repoRoot);

        if (!base || !has(base)) {
            const who = lackingBranch ?? 'the other side';
            return [chainEntry(info, 'dropped',
                `The line existed on one side of this merge, but ${who} never had it (its copy of the file predates the line). ` +
                `The merge result lost the line - typically the auto conflict resolution kept ${who}'s version of the file.`)];
        }

        const carried = chainEntry(info, 'carried',
            `This merge brought the removal into the branch: the line was removed on ${lackingBranch ?? 'the merged-in side'} and the merge kept that removal.`);
        const inner = removalIn(`${base}..${pNo}`);
        return inner ? [carried, ...locate(inner, depth + 1)] : [carried];
    };

    const top = removalIn(tip);
    return top ? locate(top, 0) : [];
}

function enrichWithOriginBranch(commits: CommitEntry[], repoRoot: string, queryBranch: string): CommitEntry[] {
    return commits.map(c => ({ ...c, originBranch: c.originBranch ?? getOriginBranch(c.hash, repoRoot, queryBranch) }));
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

                // Pass 3: if the line is gone from the branch tip, name the commit that lost it
                // (including removals made inside merge commits, which pickaxe cannot see).
                if (intent.type === 'FIND_BOTH' || intent.type === 'FIND_REMOVED') {
                    let chain: CommitEntry[] = [];
                    try { chain = traceRemovalChain(intent.searchString, branch, relFile, repoRoot); }
                    catch { /* non-fatal: fall back to the plain results */ }
                    if (chain.length > 0) {
                        const chainHashes = new Set(chain.map(c => c.hash));
                        commits = [...chain, ...commits.filter(c => !chainHashes.has(c.hash))];
                        // Stable sort: equal dates keep the chain order (carried merge before dropping merge)
                        commits.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
                    }
                }

                return mk({ commits: enrichWithOriginBranch(commits, repoRoot, branch) });
            }

            case 'FULL_HISTORY': {
                // -m exposes merge commits that silently changed the file via conflict
                // resolution — these are invisible to standard git log without this flag.
                const args = [
                    'log', '--full-history', '-m', branch,
                    '--format=COMMIT_MARKER:%H|%P|%ad|%an|%s',
                    '--date=format:%Y-%m-%d',
                    '--', relFile,
                ];
                const raw = runArgs(args, repoRoot);
                const commits = parseLogOutputWithMerges(raw);
                return mk({ commits: enrichWithOriginBranch(commits, repoRoot, branch) });
            }

            case 'RECENT_HISTORY': {
                const limit = intent.limit ?? 10;
                const cmd   = `git log --full-history ${branch} -${limit} ${logFmt} -- "${relFile}"`;
                const raw   = run(cmd, repoRoot);
                const commits = parseLogOutput(raw.replace(/^"/, '').replace(/"$/, ''));
                return mk({ commits: enrichWithOriginBranch(commits, repoRoot, branch) });
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
