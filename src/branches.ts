import { execFileSync } from 'child_process';

// A branch the user can trace. Local branches are shown by their plain name ("rbkuat"), remote ones with their remote
// ("origin/rbkuat"), so the two are never mixed up. `ref` is the fully qualified git ref, which is unambiguous even when a
// local and a remote branch (or a local branch such as "promotion/P34277" and a remote called "promotion") would clash.
export interface BranchRef {
    ref: string;
    label: string;
    kind: 'local' | 'remote';
}

export interface BranchList {
    local: BranchRef[];
    remote: BranchRef[];
    /** the checked-out branch, when HEAD is on one */
    current?: string;
}

const git = (args: string[], cwd: string): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

export function listBranchRefs(cwd: string): BranchList {
    let out: string;
    try {
        out = git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], cwd);
    } catch {
        return { local: [], remote: [] };
    }
    const local: BranchRef[] = [];
    const remote: BranchRef[] = [];
    for (const ref of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
        if (ref.startsWith('refs/heads/')) {
            local.push({ ref, label: ref.slice('refs/heads/'.length), kind: 'local' });
        } else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
            remote.push({ ref, label: ref.slice('refs/remotes/'.length), kind: 'remote' });
        }
    }
    let current: string | undefined;
    try {
        const b = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim();
        if (b && b !== 'HEAD') current = b;
    } catch { /* a repo with no commits yet */ }
    return { local, remote, current };
}

// A branch name without a slash after the remote prefix ("origin/rbkuat", or "rbkuat" for a local one) is an environment
// branch in this team's pipeline.
const isEnvStyle = (b: BranchRef): boolean => !(b.kind === 'remote' ? b.label.slice(b.label.indexOf('/') + 1) : b.label).includes('/');

/** Local branches: the checked-out one first, then environment-style names, then the rest. */
export function orderLocal(list: BranchRef[], current?: string): BranchRef[] {
    const byLabel = (a: BranchRef, b: BranchRef): number => a.label.localeCompare(b.label);
    const cur = list.filter((b) => b.label === current);
    const rest = list.filter((b) => b.label !== current);
    return [...cur, ...rest.filter(isEnvStyle).sort(byLabel), ...rest.filter((b) => !isEnvStyle(b)).sort(byLabel)];
}

/** Remote branches: environment-style names first, then the rest with the highest-looking names (newest promotions) first. */
export function orderRemote(list: BranchRef[]): BranchRef[] {
    const byLabel = (a: BranchRef, b: BranchRef): number => a.label.localeCompare(b.label);
    return [...list.filter(isEnvStyle).sort(byLabel), ...list.filter((b) => !isEnvStyle(b)).sort(byLabel).reverse()];
}
