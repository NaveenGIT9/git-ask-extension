import { execSync, spawnSync } from 'child_process';
import * as path from 'path';
import { Intent, LineContext } from './intentParser';

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
    // For those merges: "Merging <mergeFrom> to <mergeInto>" - the mistake happened ON mergeInto while
    // merging mergeFrom in; it is not an "origin" of the change.
    mergeInto?: string;
    mergeFrom?: string;
}

export interface GitResult {
    intent: Intent;
    commits?: CommitEntry[];
    raw?: string;
    error?: string;
    repoRoot?: string;
    githubBaseUrl?: string;
    relativeFile?: string;
    // One line saying how the result was found, e.g. "Line 1855 traced by position on origin/rbkqa".
    scopeNote?: string;
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
            ['log', '--ancestry-path', '--merges', '--format=%H|%P|%s', `${hash}..${targetRef}`],
            repoRoot
        );
        const merges = raw.split('\n').map(l => l.trim()).filter(Boolean);
        if (merges.length === 0) return undefined;

        // Last entry = oldest merge = the one that first introduced hash to this line
        const [, parentsRaw, ...subject] = merges[merges.length - 1].split('|');
        const match = subject.join('|').match(/Merging (\S+) (?:to|into) (\S+)/i);
        if (!match) return undefined;
        const [, src, dst] = match;

        // "Merging <src> to <dst>": the commit only came from <src> if it is part of the merged-in
        // (second) parent. If it was already on <dst>'s own history it was committed directly on
        // <dst>, and the merge of some other branch afterwards says nothing about where it came from.
        const secondParent = parentsRaw.trim().split(/\s+/)[1];
        if (secondParent && !isAncestor(hash, secondParent, repoRoot)) return dst.trim();
        return src.trim();
    } catch { /* non-fatal */ }
    return undefined;
}

function isAncestor(ancestor: string, descendant: string, repoRoot: string): boolean {
    return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoRoot }).status === 0;
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
    const { src, dst } = isMerge ? parseMergeMessage(info.message) : { src: undefined, dst: undefined };
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
        mergeFrom:      src,
        mergeInto:      dst,
    };
}

/**
 * Explain every point where the searched line disappeared from the branch - whether or not it is
 * back in the file now (a line that was removed by a merge and later re-added still has that
 * removal in its lifecycle).
 *
 * Walks the branch's first-parent history to each commit where the line vanished, then, if that is a
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
                `The line was lost by this merge itself, not by a commit in ${who}. It existed on ${pHas === pA ? (dst ?? 'the target branch') : (src ?? 'the other side')}, ` +
                `but ${who}'s copy of the file predates the line, and the merge result ended up with that older copy ` +
                `(typically the auto conflict resolution kept ${who}'s version of the file).`)];
        }

        const carried = chainEntry(info, 'carried',
            `This merge brought the removal into the branch: the line was removed on ${lackingBranch ?? 'the merged-in side'} and the merge kept that removal.`);
        const inner = removalIn(`${base}..${pNo}`);
        return inner ? [carried, ...locate(inner, depth + 1)] : [carried];
    };

    // Every commit on the branch's own history where the line went from present to absent
    // (a commit that only lowered the count while the line is still present is skipped by has()).
    const removals = firstParentPickaxe(tip, searchString, relFile, repoRoot)
        .filter(h => !has(h))
        .slice(0, 10);

    const seen = new Set<string>();
    const chain: CommitEntry[] = [];
    for (const hash of removals) {
        for (const entry of locate(hash, 0)) {
            if (seen.has(entry.hash)) continue;
            seen.add(entry.hash);
            chain.push(entry);
        }
    }
    return chain;   // newest first
}

// Finds where the selected line(s) sit in the file as it is at `rev`. The editor may be showing unsaved edits or
// a different branch, so the editor's line number is only a hint: the lines are matched by content plus the
// neighbouring lines, widest context first, and the candidate closest to the editor's line wins.
function locateLines(relFile: string, rev: string, ctx: LineContext, repoRoot: string): { start: number; end: number } | undefined {
    let text: string;
    try { text = runArgs(['show', `${rev}:${relFile}`], repoRoot); } catch { return undefined; }
    const file = text.split(/\r?\n/).map(l => l.trim());
    const tail = (a: string[], n: number): string[] => (n > 0 ? a.slice(-n) : []);

    for (const [b, a] of [[2, 2], [1, 1], [0, 0]]) {
        const above = tail(ctx.before, b);
        const pattern = [...above, ...ctx.lines, ...ctx.after.slice(0, a)];
        const hits: number[] = [];
        for (let i = 0; i + pattern.length <= file.length; i++) {
            if (pattern.every((p, k) => file[i + k] === p)) hits.push(i + above.length + 1);
        }
        // With no context at all, an ambiguous match would be a guess, so only accept a unique one.
        if (hits.length === 0 || (b === 0 && hits.length > 1)) continue;
        const start = hits.reduce((best, h) => (Math.abs(h - ctx.approxLine) < Math.abs(best - ctx.approxLine) ? h : best));
        return { start, end: start + ctx.lines.length - 1 };
    }
    return undefined;
}

// Parses `git log -L` output: each commit shows only the diff of the traced lines.
function parseLineLog(raw: string): CommitEntry[] {
    const commits: CommitEntry[] = [];
    let current: CommitEntry | null = null;
    for (const line of raw.split('\n')) {
        if (line.startsWith('COMMIT_MARKER:')) {
            if (current) commits.push(current);
            const [hash, date, author, ...msg] = line.replace('COMMIT_MARKER:', '').split('|');
            current = { hash: hash.trim(), shortHash: hash.trim().slice(0, 7), date: date.trim(), author: author.trim(), message: msg.join('|').trim(), lines: [] };
            continue;
        }
        if (!current) continue;
        if (line.startsWith('+') && !line.startsWith('+++')) current.lines!.push(`+ ${line.slice(1).trim()}`);
        else if (line.startsWith('-') && !line.startsWith('---')) current.lines!.push(`- ${line.slice(1).trim()}`);
    }
    if (current) commits.push(current);
    for (const c of commits) {
        const added = c.lines!.some(l => l.startsWith('+'));
        const removed = c.lines!.some(l => l.startsWith('-'));
        c.action = added && removed ? '~' : added ? '+' : removed ? '-' : undefined;
        // A commit listed with no diff for these lines is a merge that resolved them (e.g. a Copado conflict merge).
        if (!c.lines!.length && /^Merging /i.test(c.message)) { c.isMerge = true; c.note = 'Merge commit: it resolved a conflict touching these lines (no line diff to show).'; }
    }
    return commits;
}

// For a multi-line block: the search finds commits through one line of it, so check each commit's diff
// (against its first parent, which also covers merge resolutions) for the other lines and show which ones moved.
function annotateBlock(commits: CommitEntry[], block: string[], relFile: string, repoRoot: string): CommitEntry[] {
    const wanted = new Set(block.map(l => l.trim()).filter(Boolean));
    return commits.map(c => {
        let patch: string;
        try { patch = runArgs(['diff', '--no-color', '--unified=0', `${c.hash}^1`, c.hash, '--', relFile], repoRoot); }
        catch { return c; }   // root commit: no parent to compare with
        const matched = new Set<string>();
        for (const l of patch.split('\n')) {
            const isChange = (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---'));
            if (isChange && wanted.has(l.slice(1).trim())) matched.add(`${l[0]} ${l.slice(1).trim()}`);
        }
        if (matched.size === 0) return c;
        const distinct = new Set([...matched].map(m => m.slice(2))).size;
        const note = `Touches ${distinct} of the ${wanted.size} distinct lines of your block`;
        return { ...c, lines: [...matched], note: [c.note, note].filter(Boolean).join(' · ') };
    });
}

function enrichWithOriginBranch(commits: CommitEntry[], repoRoot: string, queryBranch: string): CommitEntry[] {
    // The "lost here" / "carried in" merges are described by mergeFrom/mergeInto instead of an origin.
    return commits.map(c => c.removalRole
        ? c
        : { ...c, originBranch: getOriginBranch(c.hash, repoRoot, queryBranch) });
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

                if (intent.blockLines && intent.blockLines.length > 1) {
                    commits = annotateBlock(commits, intent.blockLines, relFile, repoRoot);
                }
                return mk({ commits: enrichWithOriginBranch(commits, repoRoot, branch) });
            }

            case 'LINE_HISTORY': {
                const ctx = intent.lineContext;
                if (!ctx || ctx.lines.length === 0) return err('No line selected.');
                // `git log -L` needs one concrete revision; with no branch given use what is checked out.
                const rev = branch === '--all' ? 'HEAD' : branch;
                const found = locateLines(relFile, rev, ctx, repoRoot);
                if (!found) {
                    // The line is not in the file at this revision (removed, or on another branch): the only way to find
                    // it is by its text, which also matches every identical line in the file.
                    const fallback = await executeIntent({ ...intent, type: 'FIND_BOTH', lineContext: undefined });
                    return { ...fallback, scopeNote: `This line is not in the file on ${rev}, so its text was searched across the whole history. ` +
                        `Identical lines elsewhere in the file can appear in the results.` };
                }
                const range = found.start === found.end ? `${found.start}` : `${found.start},${found.end}`;
                const raw = runArgs(
                    ['log', `-L${range}:${relFile}`, rev, '--format=COMMIT_MARKER:%H|%ad|%an|%s', '--date=format:%Y-%m-%d'],
                    repoRoot
                );
                const lineLabel = found.start === found.end ? `Line ${found.start}` : `Lines ${found.start}-${found.end}`;
                return mk({
                    commits: enrichWithOriginBranch(parseLineLog(raw), repoRoot, branch),
                    scopeNote: `${lineLabel} of ${rev} traced by position: only commits that changed these exact lines are shown.`,
                });
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
