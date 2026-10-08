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
    // The commit's exact time (Unix seconds), used only to order entries; the panel shows just the date.
    ts?: number;
    // For a merge that brought the traced lines into a branch: 'merged-in' = the lines were written on the merged-in
    // branch; 'carried-over' = that branch already had them from an earlier merge and this one passed them on.
    mergeStep?: 'merged-in' | 'carried-over';
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
    // Lines of the traced block that are not in that block on the branch (shown highlighted above the results).
    missingLines?: string[];
    // The line the user asked about when a block only served to identify it (see Intent.focusLine).
    focusLine?: string;
}

function getGitHubBaseUrl(repoRoot: string): string | undefined {
    try {
        const remote = execSync('git remote get-url origin', { cwd: repoRoot, encoding: 'utf8' }).trim();
        const ssh    = remote.match(/git@github\.com:(.+?)(?:\.git)?$/);
        // The URL may carry credentials ("https://<token>@github.com/..."); only the owner/repo part is used for links.
        const https  = remote.match(/https:\/\/(?:[^@\/]+@)?github\.com\/(.+?)(?:\.git)?$/);
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

// Orders entries newest first by the commit's exact time. Several commits often share a day, and a merge must come after
// the commits it merges, so the date alone is not enough. At the very same second a merge counts as newer than a plain commit.
function byNewest(a: CommitEntry, b: CommitEntry): number {
    if (a.ts && b.ts && a.ts !== b.ts) return b.ts - a.ts;
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return (a.isMerge ? 0 : 1) - (b.isMerge ? 0 : 1);   // newest first: a merge goes before the commits it merges
}

function parsePickaxeOutput(raw: string, searchString: string): CommitEntry[] {
    const commits: CommitEntry[] = [];
    let current: CommitEntry | null = null;
    const sl = searchString.toLowerCase();

    for (const line of raw.split('\n')) {
        if (line.startsWith('COMMIT_MARKER:')) {
            if (current) commits.push(current);
            const [hash, date, ct, author, ...msg] = line.replace('COMMIT_MARKER:', '').split('|');
            current = {
                hash: hash.trim(),
                shortHash: hash.trim().slice(0, 7),
                date: date.trim(),
                ts: Number(ct) || undefined,
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
    const chrono = [...commits].sort((a, b) => byNewest(b, a));
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
            '--format=%H|%ad|%ct|%an|%s', '--date=format:%Y-%m-%d',
            `--after=${earlier.date}`, `--before=${later.date}`,
            '--', relFile,
        ];
        const rangeOut = runArgs(rangeArgs, repoRoot);
        const entries = rangeOut.split('\n').filter(l => l.trim()).map(line => {
            const [hash, date, ct, author, ...msg] = line.split('|');
            return { hash: hash.trim(), date, ts: Number(ct) || undefined, author, message: msg.join('|').trim() };
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
            ts:        e.ts,
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
    ts?: number;
    author: string;
    message: string;
}

function commitInfo(hash: string, repoRoot: string): CommitInfo {
    const out = runArgs(
        ['show', '-s', '--format=%H|%P|%ad|%ct|%an|%s', '--date=format:%Y-%m-%d', hash],
        repoRoot
    ).trim();
    const [h, parentsRaw, date, ct, author, ...msg] = out.split('|');
    return {
        hash:    h.trim(),
        parents: parentsRaw.trim().split(/\s+/).filter(Boolean),
        date:    date.trim(),
        ts:      Number(ct) || undefined,
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
        ts:             info.ts,
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
// How many lines of the file at `rev` have exactly this (trimmed) text; 0 when the file is not there.
function countLineInFile(relFile: string, rev: string, line: string, repoRoot: string): number {
    try {
        return runArgs(['show', `${rev}:${relFile}`], repoRoot).split(/\r?\n/).filter(l => l.trim() === line).length;
    } catch { return 0; }
}

function locateLines(relFile: string, rev: string, ctx: LineContext, repoRoot: string): { start: number; end: number } | undefined {
    let text: string;
    try { text = runArgs(['show', `${rev}:${relFile}`], repoRoot); } catch { return undefined; }
    return locateInLines(text.split(/\r?\n/).map(l => l.trim()), ctx);
}

// Same search on the file's (trimmed) lines, so it can run on file text that was read in bulk.
function locateInLines(file: string[], ctx: LineContext): { start: number; end: number } | undefined {
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

// Reads the file at many commits with one `git cat-file --batch` per chunk and reduces each to fn(trimmed lines).
// A commit where the file does not exist maps to null.
function scanFileAtCommits<T>(hashes: string[], relFile: string, repoRoot: string, fn: (lines: string[]) => T): Map<string, T | null> {
    const out = new Map<string, T | null>();
    for (let i = 0; i < hashes.length; i += 40) {
        const chunk = hashes.slice(i, i + 40);
        const r = spawnSync('git', ['cat-file', '--batch'], {
            cwd: repoRoot, input: chunk.map(h => `${h}:${relFile}\n`).join(''), maxBuffer: 400 * 1024 * 1024,
        });
        if (r.error || r.status !== 0 || !r.stdout) continue;
        const buf = r.stdout;
        let pos = 0;
        for (const h of chunk) {
            const nl = buf.indexOf(10, pos);
            if (nl < 0) break;
            const header = buf.toString('utf8', pos, nl);
            if (header.endsWith(' missing')) { out.set(h, null); pos = nl + 1; continue; }
            const size = parseInt(header.split(' ')[2], 10);
            if (Number.isNaN(size)) break;
            out.set(h, fn(buf.toString('utf8', nl + 1, nl + 1 + size).split(/\r?\n/).map(l => l.trim())));
            pos = nl + 1 + size + 1;
        }
    }
    return out;
}

// `git log -L` skips a merge whose lines are identical to one of its parents, so a merge that brought the lines into
// the branch (first parent lacked them, the merged-in side had them) is invisible there. Find those merges by walking
// the branch's own (first-parent) history and checking, commit by commit, whether the lines are there.
function mergesBringingInLines(
    ctx: LineContext, rev: string, relFile: string, repoRoot: string, depth = 0, seen = new Set<string>(),
): CommitEntry[] {
    const listed = runArgs(['rev-list', '--first-parent', '--parents', rev, '--', relFile], repoRoot)
        .split('\n').map(l => l.trim().split(/\s+/)).filter(p => p[0]).slice(0, 2000);
    const has = scanFileAtCommits([...new Set(listed.flat())], relFile, repoRoot, lines => locateInLines(lines, ctx) !== undefined);
    const entries: CommitEntry[] = [];
    for (const [hash, ...parents] of listed) {
        if (parents.length < 2 || !has.get(hash) || has.get(parents[0]) || !has.get(parents[1])) continue;
        if (seen.has(hash)) continue;
        seen.add(hash);
        const info = commitInfo(hash, repoRoot);
        const { src, dst } = parseMergeMessage(info.message);
        // The merged-in side got the lines from somewhere too (usually from a merge into its own promotion branch,
        // then from the feature branch): follow it, so the whole chain feature -> promotion -> branch is listed.
        const earlier = depth < 6 ? mergesBringingInLines(ctx, parents[1], relFile, repoRoot, depth + 1, seen) : [];
        const from = src ?? 'the other branch';
        const into = dst ?? 'this branch';
        // No earlier merge: the lines were written on the merged-in branch itself and this merge brought them over.
        // With an earlier merge: the merged-in branch already had them from a merge of its own; this merge only carried them on.
        const note = earlier.length === 0
            ? `Merged ${from} into ${into}. The lines were written on ${from}; ${into} did not have them before this merge.`
            : `Carried over from ${from} into ${into}. ${from} already had these lines (they reached it through an earlier merge); ${into} did not have them before this merge.`;
        entries.push({
            hash: info.hash, shortHash: info.hash.slice(0, 7), date: info.date, ts: info.ts, author: info.author, message: info.message,
            action: '+', lines: ctx.lines.map(l => `+ ${l}`), isMerge: true,
            isAutoConflict: info.message.toLowerCase().includes('auto conflict'),
            note, mergeFrom: src, mergeInto: dst,
            mergeStep: earlier.length === 0 ? 'merged-in' : 'carried-over',
        });
        entries.push(...earlier);
    }
    return entries;
}

// Parses `git log -L` output: each commit shows only the diff of the traced lines.
function parseLineLog(raw: string): CommitEntry[] {
    const commits: CommitEntry[] = [];
    let current: CommitEntry | null = null;
    for (const line of raw.split('\n')) {
        if (line.startsWith('COMMIT_MARKER:')) {
            if (current) commits.push(current);
            const [hash, date, ct, author, ...msg] = line.replace('COMMIT_MARKER:', '').split('|');
            current = { hash: hash.trim(), shortHash: hash.trim().slice(0, 7), date: date.trim(), ts: Number(ct) || undefined, author: author.trim(), message: msg.join('|').trim(), lines: [] };
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

interface BlockRegion { score: number; lines: Set<string> }

// Finds where a block sits in a file: spans that start at a line equal to the block's first line and end at the
// next line equal to its last, scored by how many of the block's distinct lines they contain. The best span wins.
// This is what tells apart "<fields>NAME</fields> inside THIS related list" from the same line in all the others.
function bestBlockRegion(fileLines: string[], block: string[], approxLine?: number): BlockRegion | undefined {
    const distinct = [...new Set(block)];
    const first = block[0];
    const last = block[block.length - 1];
    const maxSpan = block.length * 3 + 5;
    let best: (BlockRegion & { start: number }) | undefined;
    for (let i = 0; i < fileLines.length; i++) {
        if (fileLines[i] !== first) continue;
        let j = -1;
        for (let k = i + 1; k < fileLines.length && k <= i + maxSpan; k++) {
            if (fileLines[k] === last) { j = k; break; }
        }
        if (j < 0) continue;
        const lines = new Set(fileLines.slice(i, j + 1));
        const score = distinct.filter(l => lines.has(l)).length;
        const nearer = best && approxLine !== undefined && Math.abs(i + 1 - approxLine) < Math.abs(best.start + 1 - approxLine);
        if (!best || score > best.score || (score === best.score && nearer)) best = { score, lines, start: i };
    }
    const needed = Math.max(2, Math.ceil(distinct.length * 0.6));
    return best && best.score >= needed ? { score: best.score, lines: best.lines } : undefined;
}

/**
 * For a block that no longer matches the file as it is at `rev`: find which of its lines are missing from the
 * block there, then walk the file's history and report, inside this block only, where each missing line was
 * added and where it was lost. Counting the line file-wide would not work: the same line (e.g. <fields>NAME</fields>)
 * exists in many other blocks, so a merge that drops it here and adds it elsewhere leaves the file-wide count unchanged.
 * Returns undefined when the block itself cannot be found at `rev`.
 */
function traceBlockLoss(
    block: string[], rev: string, relFile: string, repoRoot: string, approxLine?: number,
    opts: { wholeFile?: boolean; focus?: string } = {},
): { entries: CommitEntry[]; missing: string[]; truncated: boolean; gone?: boolean } | undefined {
    block = block.filter(l => l !== '');   // blank lines cannot anchor a block
    // wholeFile: one line whose text is unique in the file. A commit "has" the line when that exact text is anywhere in
    // the file, so no block position is involved and line numbers do not matter.
    const wholeFile = opts.wholeFile === true;
    if (block.length < (wholeFile ? 1 : 2)) return undefined;
    const where = wholeFile ? 'this file' : 'this block';
    const regionOf = (lines: string[]): BlockRegion | null => {
        if (!wholeFile) return bestBlockRegion(lines, block, approxLine) ?? null;
        const inFile = new Set(lines);
        return { score: 1, lines: new Set(block.filter(l => inFile.has(l))) };   // only the lines of interest are kept
    };
    const regionCache = new Map<string, BlockRegion | null>();
    const regionAt = (hash: string): BlockRegion | null => {
        let r = regionCache.get(hash);
        if (r === undefined) {
            try {
                const text = runArgs(['show', `${hash}:${relFile}`], repoRoot);
                r = regionOf(text.split(/\r?\n/).map(l => l.trim()));
            } catch { r = null; }
            regionCache.set(hash, r);
        }
        return r;
    };
    // Reading the file at hundreds of commits one `git show` at a time takes minutes; one `cat-file --batch`
    // process per chunk of revisions is much faster. Each file is reduced to its block region straight away.
    const prefetch = (hashes: string[]): void => {
        const todo = hashes.filter(h => !regionCache.has(h));
        for (let i = 0; i < todo.length; i += 40) {
            const chunk = todo.slice(i, i + 40);
            const r = spawnSync('git', ['cat-file', '--batch'], {
                cwd: repoRoot, input: chunk.map(h => `${h}:${relFile}\n`).join(''), maxBuffer: 400 * 1024 * 1024,
            });
            if (r.error || r.status !== 0 || !r.stdout) continue;   // anything not cached is read one at a time later
            const buf = r.stdout;
            let pos = 0;
            for (const h of chunk) {
                const nl = buf.indexOf(10, pos);
                if (nl < 0) break;
                const header = buf.toString('utf8', pos, nl);
                if (header.endsWith(' missing')) { regionCache.set(h, null); pos = nl + 1; continue; }
                const size = parseInt(header.split(' ')[2], 10);
                if (Number.isNaN(size)) break;
                const text = buf.toString('utf8', nl + 1, nl + 1 + size);
                regionCache.set(h, regionOf(text.split(/\r?\n/).map(l => l.trim())));
                pos = nl + 1 + size + 1;
            }
        }
    };
    // 'Y' the block holds the line, 'N' the block exists but lacks it, '?' the block is not in that revision
    const stateAt = (hash: string, line: string): 'Y' | 'N' | '?' => {
        const r = regionAt(hash);
        return !r ? '?' : r.lines.has(line) ? 'Y' : 'N';
    };

    const tipRegion = regionAt(rev);
    const distinctLines = [...new Set(block)];
    if (wholeFile && !tipRegion) return undefined;   // the file itself is not at this revision
    // focus: one line inside the block. The block only says which copy is meant; that line's whole life inside the block is wanted.
    const focus = opts.focus && distinctLines.includes(opts.focus) ? opts.focus : undefined;
    if (focus && !tipRegion) return undefined;       // the block is not at this revision, so there is no copy to follow
    // In whole-file mode the line's whole life is wanted, whether or not it is in the file now.
    const missing = focus ? [focus] : wholeFile ? distinctLines : tipRegion ? distinctLines.filter(l => stateAt(rev, l) === 'N') : distinctLines;
    if (!wholeFile && !focus && tipRegion && missing.length === 0) return undefined;   // the block is intact here

    const MAX_COMMITS = 2000;
    const listed = runArgs(['rev-list', '--full-history', '--parents', rev, '--', relFile], repoRoot)
        .split('\n').map(l => l.trim().split(/\s+/)).filter(p => p[0]);
    const truncated = listed.length > MAX_COMMITS;
    const commits = listed.slice(0, MAX_COMMITS);
    prefetch([...new Set(commits.flat())]);

    // Merges that brought the line(s) or the block into the branch: the branch the merge went into (first parent) did not
    // have them, the merged-in side (second parent) did. "Carried over" when that side itself got them through an earlier
    // merge; "merged in" when they were written on that side. (`git log` alone hides these merges, as in the selection trace.)
    const mergeInEntries = (isIn: (hash: string) => boolean, what: string, pronoun: string, lines: string[]): CommitEntry[] => {
        const candidates = commits.filter(([h, ...p]) => p.length > 1 && isIn(h) && !isIn(p[0]) && isIn(p[1]));
        return candidates.map(([hash, ...parents]) => {
            const info = commitInfo(hash, repoRoot);
            const { src, dst } = parseMergeMessage(info.message);
            const carried = candidates.some(([other]) => other !== hash && isAncestor(other, parents[1], repoRoot));
            const from = src ?? 'the other branch';
            const into = dst ?? 'this branch';
            const note = carried
                ? `Carried over from ${from} into ${into}. ${from} already had ${what} (they reached it through an earlier merge); ${into} did not have ${pronoun} before this merge.`
                : `Merged ${from} into ${into}. ${what} came from ${from}; ${into} did not have ${pronoun} before this merge.`;
            return {
                hash: info.hash, shortHash: info.hash.slice(0, 7), date: info.date, ts: info.ts, author: info.author, message: info.message,
                action: '+' as const, lines, isMerge: true, isAutoConflict: info.message.toLowerCase().includes('auto conflict'),
                note, mergeFrom: src, mergeInto: dst, mergeStep: carried ? ('carried-over' as const) : ('merged-in' as const),
            };
        });
    };

    // The whole block is gone from the file at `rev`: use the whole block, not one of its lines. A commit "has" the block
    // when it is found there (see bestBlockRegion); report where it was added and where it was taken out.
    if (!tipRegion) {
        const has = (h: string): boolean => regionAt(h) !== null;
        const shown = (prefix: string): string[] => {
            const out = block.slice(0, 12).map(l => `${prefix} ${l}`);
            return block.length > 12 ? [...out, `${prefix} … ${block.length - 12} more lines`] : out;
        };
        const goneEntries: CommitEntry[] = [];
        for (const [hash, ...parents] of commits) {
            const mine = has(hash);
            if (!mine && parents.length > 0 && has(parents[0])) {
                const info = commitInfo(hash, repoRoot);
                let role: 'dropped' | 'carried' = 'dropped';
                let note = 'This commit removed the whole block (or the file).';
                if (info.parents.length > 1) {
                    const base = mergeBase(info.parents[0], info.parents[1], repoRoot);
                    if (base && has(base)) {
                        role = 'carried';
                        note = 'Brought in the removal of the whole block from the other branch, where it had already been removed.';
                    } else {
                        note = 'This merge lost the whole block: one side had it, the other never did, and the merge kept the version without it.';
                    }
                }
                goneEntries.push({ ...chainEntry(info, role, note), lines: shown('-') });
            } else if (mine && !parents.some(has)) {
                const info = commitInfo(hash, repoRoot);
                goneEntries.push({ ...chainEntry(info, 'carried', 'Added the whole block here.'), action: '+', lines: shown('+'), removalRole: undefined });
            }
        }
        goneEntries.push(...mergeInEntries(has, 'The block', 'it', shown('+')));
        if (goneEntries.length === 0) return undefined;   // the block never existed in this file: nothing to trace as a block
        goneEntries.sort(byNewest);
        return { entries: goneEntries, missing: distinctLines, truncated, gone: true };
    }

    const entries: CommitEntry[] = [];
    const seen = new Set<string>();
    for (const line of missing) {
        for (const [hash, ...parents] of commits) {
            const mine = stateAt(hash, line);
            const parentStates = parents.map(p => stateAt(p, line));
            const key = `${hash}|${line}`;
            if (seen.has(key)) continue;
            // The first parent is the branch the commit was made on / merged into. Only when IT still had the line did this
            // commit take the line away. A merge whose first parent already lacked the line, and whose other parent is just
            // an older copy that still has it, changed nothing for the branch it was merged into.
            if (mine === 'N' && parentStates[0] === 'Y') {
                seen.add(key);
                const info = commitInfo(hash, repoRoot);
                let role: 'dropped' | 'carried' = 'dropped';
                let note = `Removed "${line}" from ${where}.`;
                if (info.parents.length > 1) {
                    const base = mergeBase(info.parents[0], info.parents[1], repoRoot);
                    if (base && stateAt(base, line) === 'Y') {
                        role = 'carried';
                        note = `Brought in a removal of "${line}" from the other branch, where it had already been removed.`;
                    } else {
                        note = `This merge lost "${line}" from ${where}: one side had it, the other never did, and the merge kept the version without it.`;
                    }
                }
                entries.push({ ...chainEntry(info, role, note), lines: [`- ${line}`] });
            } else if (mine === 'Y' && !parentStates.includes('Y')) {
                seen.add(key);
                const info = commitInfo(hash, repoRoot);
                entries.push({
                    ...chainEntry(info, 'carried', `Added "${line}" to ${where}.`),
                    action: '+', lines: [`+ ${line}`], removalRole: undefined,
                });
            }
        }
    }
    // Merges that brought a missing line into the branch; one entry per merge, listing every line it brought in.
    const mergedIn = new Map<string, CommitEntry>();
    for (const line of missing) {
        for (const e of mergeInEntries((h) => stateAt(h, line) === 'Y', 'The line', 'it', [`+ ${line}`])) {
            const existing = mergedIn.get(e.hash);
            if (existing) existing.lines = [...(existing.lines ?? []), ...(e.lines ?? [])];
            else mergedIn.set(e.hash, e);
        }
    }
    entries.push(...mergedIn.values());
    entries.sort(byNewest);
    return { entries, missing, truncated };
}

function blockLossNote(loss: { missing: string[]; truncated: boolean; gone?: boolean }, rev: string): string {
    if (loss.gone) {
        return `Your block is no longer in this file on ${rev}. Showing where the whole block was added and where it was removed.` +
            (loss.truncated ? " Only the most recent 2000 commits of the file were checked." : "");
    }
    const list = loss.missing.map(l => `"${l}"`).join(', ');
    return `Your block is not exactly as selected on ${rev}: ${loss.missing.length} of its lines ${loss.missing.length === 1 ? 'is' : 'are'} missing (${list}). ` +
        `Showing, inside this block only, where ${loss.missing.length === 1 ? 'it was' : 'they were'} added and where ${loss.missing.length === 1 ? 'it was' : 'they were'} lost.` +
        (loss.truncated ? ' Only the most recent 2000 commits of the file were checked.' : '');
}

function enrichWithOriginBranch(commits: CommitEntry[], repoRoot: string, queryBranch: string): CommitEntry[] {
    // Every commit gets its origin branch, including the "lost here" / "carried in" ones; those merges also keep
    // their mergeFrom/mergeInto ("on X while merging Y"), which the panel shows next to it.
    // A merge whose message names its branch ("Merging X to Y") was made on Y, so Y is its origin; the lookup below
    // would name the next branch that later carried it, which is not where the merge was made.
    return commits.map(c => ({ ...c, originBranch: c.isMerge && c.mergeInto ? c.mergeInto : getOriginBranch(c.hash, repoRoot, queryBranch) }));
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
                // A pasted block that is still partly in the file: trace its missing lines inside that block.
                if (intent.blockLines && intent.blockLines.length > 1) {
                    const rev = branch === '--all' ? 'HEAD' : branch;
                    const loss = traceBlockLoss(intent.blockLines, rev, relFile, repoRoot);
                    if (loss) return mk({ commits: enrichWithOriginBranch(loss.entries, repoRoot, branch), scopeNote: blockLossNote(loss, rev), missingLines: loss.missing });
                }
                // Pass 1: pickaxe (no -m) — fast, finds direct commits correctly.
                const args = [
                    'log', `-S${intent.searchString}`,
                    '--full-history', branch, '-p',
                    '--format=COMMIT_MARKER:%H|%ad|%ct|%an|%s',
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
                    commits.sort(byNewest);
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
                        commits.sort(byNewest);
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
                // The user selected one repeated line and then let Git Ask widen the selection to its block: the block only
                // identifies which copy was meant, so show that line's history inside that block.
                if (intent.focusLine && ctx.lines.length > 1) {
                    const life = traceBlockLoss(ctx.lines, rev, relFile, repoRoot, ctx.approxLine, { focus: intent.focusLine });
                    if (life && life.entries.length > 0) {
                        return mk({
                            commits: enrichWithOriginBranch(life.entries, repoRoot, branch),
                            focusLine: intent.focusLine,
                            scopeNote: `Tracing the line you selected, ${intent.focusLine}, inside the block around it on ${rev}. The block only identifies which copy you meant: ` +
                                `the history below is that line's (when it was added, merged in, removed).` + (life.truncated ? ' Only the most recent 2000 commits of the file were checked.' : ''),
                        });
                    }
                }
                // One selected line whose text appears only once in the file: its position tells nothing (other lines are
                // inserted, edited and reordered around it all the time), so trace its content instead.
                const copies = ctx.lines.length === 1 && ctx.lines[0] !== '' ? countLineInFile(relFile, rev, ctx.lines[0], repoRoot) : 0;
                // A line that sits in several places cannot be traced reliably (by position the answer would be about whatever
                // else happened to be at that line number), so ask for a block instead of guessing.
                if (copies > 1) {
                    return err(`This line appears ${copies} times in the file on ${rev}, so Git Ask cannot tell which one you mean. ` +
                        `Select the whole block it belongs to (for example from <relatedLists> to </relatedLists>), or add a few lines around it, and trace again.`);
                }
                if (copies === 1) {
                    const life = traceBlockLoss(ctx.lines, rev, relFile, repoRoot, ctx.approxLine, { wholeFile: true });
                    if (life && life.entries.length > 0) {
                        return mk({
                            commits: enrichWithOriginBranch(life.entries, repoRoot, branch),
                            scopeNote: `This line's text appears once in the file on ${rev}, so it was traced by its content (line numbers do not matter): ` +
                                `where it was added, removed and merged in.` + (life.truncated ? ' Only the most recent 2000 commits of the file were checked.' : ''),
                        });
                    }
                }
                const found = locateLines(relFile, rev, ctx, repoRoot);
                if (!found && ctx.lines.length > 1) {
                    // The block is there but not exactly as selected: say which of its lines are missing and who lost them.
                    const loss = traceBlockLoss(ctx.lines, rev, relFile, repoRoot, ctx.approxLine);
                    if (loss) return mk({ commits: enrichWithOriginBranch(loss.entries, repoRoot, branch), scopeNote: blockLossNote(loss, rev), missingLines: loss.missing });
                }
                if (!found) {
                    // The line is not in the file at this revision (removed, or on another branch): the only way to find
                    // it is by its text, which also matches every identical line in the file.
                    const fallback = await executeIntent({ ...intent, type: 'FIND_BOTH', lineContext: undefined });
                    return { ...fallback, scopeNote: `This line is not in the file on ${rev}, so its text was searched across the whole history. ` +
                        `Identical lines elsewhere in the file can appear in the results.` };
                }
                const range = found.start === found.end ? `${found.start}` : `${found.start},${found.end}`;
                const raw = runArgs(
                    ['log', `-L${range}:${relFile}`, rev, '--format=COMMIT_MARKER:%H|%ad|%ct|%an|%s', '--date=format:%Y-%m-%d'],
                    repoRoot
                );
                const lineLabel = found.start === found.end ? `Line ${found.start}` : `Lines ${found.start}-${found.end}`;
                const traced = parseLineLog(raw);
                let viaMerges: CommitEntry[] = [];
                try { viaMerges = mergesBringingInLines(ctx, rev, relFile, repoRoot); }
                catch { /* non-fatal: show the plain trace */ }
                const known = new Set(traced.map(c => c.hash));
                const all = [...traced, ...viaMerges.filter(m => !known.has(m.hash))]
                    .sort(byNewest);
                return mk({
                    commits: enrichWithOriginBranch(all, repoRoot, branch),
                    scopeNote: `${lineLabel} of ${rev} traced by position: the commits that changed these exact lines, plus the merges that brought them into the branch.`,
                });
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
