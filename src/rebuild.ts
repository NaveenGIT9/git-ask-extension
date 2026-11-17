import { spawnSync } from 'child_process';

export interface FirstParentCommit { hash: string; ts: number; subject: string }

export interface Rebuild {
    branch: string;
    // The environment branch whose history the queried branch took over.
    from: string;
    // Newest commit of `from` that the branch took; it and everything reachable from it is `from`'s history.
    takenHash: string;
    takenTs: number;
    // First merge into the branch itself after the take-over.
    restartHash: string;
    restartTs: number;
    // A branch (e.g. origin/rbkqasep22) that still holds the branch's history from before the take-over.
    oldHistoryRef?: string;
}

// The environment branch a merge was made on ("Merging promotion/P1 into rbkuat ..." -> rbkuat). Promotion, feature and
// other slashed branches are not environments, so they return undefined.
export function envTarget(subject: string): string | undefined {
    const m = subject.match(/\bmerg(?:e|ing)\b.*?\s(?:to|into)\s+'?([^\s']+)'?/i);
    if (!m) return undefined;
    const dst = m[1].replace(/^origin\//, '');
    return dst.includes('/') ? undefined : dst;
}

// `fp` is the branch's first-parent history, newest first. Where the merges into `branch` itself give way to a run of
// merges made on another environment, `branch` was reset to that environment (the most recent such point is returned).
export function findRebuildPoint(fp: FirstParentCommit[], branch: string): Omit<Rebuild, 'oldHistoryRef'> | undefined {
    const env = fp.map((c, i) => ({ i, dst: envTarget(c.subject) })).filter((x): x is { i: number; dst: string } => !!x.dst);
    for (let k = 0; k + 1 < env.length; k++) {
        if (env[k].dst !== branch || env[k + 1].dst === branch) continue;
        const from = env[k + 1].dst;
        // A stray merge or two is not a take-over: the next merges must clearly be another branch's, with none of our own.
        const next = env.slice(k + 1, k + 11);
        if (next.some(x => x.dst === branch) || next.filter(x => x.dst === from).length < 3) continue;
        const taken = fp[env[k + 1].i];
        const restart = fp[env[k].i];
        return { branch, from, takenHash: taken.hash, takenTs: taken.ts, restartHash: restart.hash, restartTs: restart.ts };
    }
    return undefined;
}

function git(args: string[], cwd: string): string | undefined {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : undefined;
}

// "refs/remotes/origin/rbkqa", "origin/rbkqa", "rbkqa", "HEAD" -> "rbkqa"; undefined for hashes and slashed branches.
export function envName(rev: string, cwd: string): string | undefined {
    const full = (git(['rev-parse', '--symbolic-full-name', rev], cwd) ?? '').trim();
    const name = full.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '');
    return name && !name.startsWith('refs/') && !name.includes('/') ? name : undefined;
}

function findOldHistoryRef(rb: Omit<Rebuild, 'oldHistoryRef'>, rev: string, cwd: string): string | undefined {
    const refs = (git(['for-each-ref', '--format=%(refname:short)|%(committerdate:unix)', `refs/remotes/*/${rb.branch}?*`, `refs/heads/${rb.branch}?*`], cwd) ?? '')
        .split('\n').filter(Boolean).map(l => { const [ref, ts] = l.split('|'); return { ref, ts: Number(ts) }; })
        .filter(r => r.ts <= rb.restartTs)
        .sort((a, b) => b.ts - a.ts);
    for (const r of refs) {
        if (spawnSync('git', ['merge-base', '--is-ancestor', r.ref, rev], { cwd }).status === 0) continue;
        const recent = (git(['log', '--first-parent', '-50', '--format=%s', r.ref], cwd) ?? '').split('\n');
        if (recent.some(s => envTarget(s) === rb.branch)) return r.ref;
    }
    return undefined;
}

export function detectRebuild(rev: string, cwd: string): Rebuild | undefined {
    const branch = envName(rev, cwd);
    if (!branch) return undefined;
    const raw = git(['log', '--first-parent', '--format=%H|%ct|%s', rev], cwd);
    if (!raw) return undefined;
    const fp = raw.split('\n').filter(Boolean).map(l => {
        const [hash, ts, ...s] = l.split('|');
        return { hash, ts: Number(ts), subject: s.join('|') };
    });
    const rb = findRebuildPoint(fp, branch);
    return rb ? { ...rb, oldHistoryRef: findOldHistoryRef(rb, rev, cwd) } : undefined;
}

export function isBeforeRebuild(hash: string, rb: Rebuild, cwd: string): boolean {
    return spawnSync('git', ['merge-base', '--is-ancestor', hash, rb.takenHash], { cwd }).status === 0;
}
