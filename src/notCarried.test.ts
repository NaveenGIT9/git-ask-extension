import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { executeIntent } from './gitService';

const LINE = '<permissionSets>Captello_User</permissionSets>';
const dirs: string[] = [];
after(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));

function repo(): { git: (...a: string[]) => string; file: string; write: (withLine: boolean, mid?: string) => void } {
    const dir = mkdtempSync(join(tmpdir(), 'gitask-notcarried-'));
    dirs.push(dir);
    // Each commit gets its own time (a day apart) so the newest-first order is not decided by ties.
    let t = 1_700_000_000;
    const git = (...args: string[]): string => {
        const when = `${(t += 86400)} +0000`;
        return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
            cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
        });
    };
    const file = join(dir, 'psg.xml');
    const write = (withLine: boolean, mid = '<b/>'): void => writeFileSync(file, ['<a>', mid, ...(withLine ? [LINE] : []), '<c/>', '</a>', ''].join('\n'));
    return { git, file, write };
}

const trace = (file: string) => executeIntent({
    type: 'LINE_HISTORY', filePath: file, branch: 'rbkqa', originalQuestion: '',
    lineContext: { lines: [LINE], before: [], after: [], approxLine: 3 },
});

test('a merge that drops a change on its way in is shown between the two adds', async () => {
    const { git, file, write } = repo();
    write(false);
    git('init', '-q', '-b', 'rbkqa');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('checkout', '-q', '-b', 'promotion/P1');
    write(true);
    git('commit', '-q', '-am', 'add line on P1');
    git('checkout', '-q', 'rbkqa');
    write(false, '<b2/>');
    git('commit', '-q', '-am', 'other change on rbkqa');
    // The merge keeps rbkqa's side of the file, dropping the line P1 added.
    git('merge', '-q', '-s', 'ours', 'promotion/P1', '-m', 'Merging promotion/P1 into rbkqa after auto conflict resolution');
    write(true, '<b2/>');
    git('commit', '-q', '-am', 'add line back');

    const r = await trace(file);
    assert.equal(r.error, undefined);
    const order = [...(r.commits ?? [])].reverse().map(c => `${c.removalRole ?? c.action}:${c.message}`);
    assert.deepEqual(order, [
        '+:add line on P1',
        'not-carried:Merging promotion/P1 into rbkqa after auto conflict resolution',
        '+:add line back',
    ]);
});

test('a merge on a promotion headed to master says so, and names the merge that brought it to rbkqa', async () => {
    const { git, file, write } = repo();
    write(false);
    git('init', '-q', '-b', 'master');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('branch', 'rbkqa');
    // feature/US-1 adds the line; a promotion to master merges it in, and master fast-forwards to the promotion.
    git('checkout', '-q', '-b', 'feature/US-1');
    write(true);
    git('commit', '-q', '-am', 'add line on US-1');
    git('checkout', '-q', '-b', 'promotion/P1', 'master');
    git('commit', '-q', '--allow-empty', '-m', 'promotion setup');
    git('merge', '-q', '--no-ff', 'feature/US-1', '-m', 'Merging feature/US-1 to promotion/P1');
    git('checkout', '-q', 'master');
    git('merge', '-q', '--ff-only', 'promotion/P1');
    // feature/US-2 is cut from master (so it carries the line) and promoted to rbkqa, where the merge keeps rbkqa's version.
    git('checkout', '-q', '-b', 'feature/US-2');
    git('commit', '-q', '--allow-empty', '-m', 'US-2 work');
    git('checkout', '-q', 'rbkqa');
    write(false, '<b2/>');
    git('commit', '-q', '-am', 'other change on rbkqa');
    git('merge', '-q', '-s', 'ours', 'feature/US-2', '-m', 'Merging feature/US-2 to promotion/P2 after auto conflict resolution');
    write(true, '<b2/>');
    git('commit', '-q', '-am', 'add line back');

    const r = await trace(file);
    assert.equal(r.error, undefined);
    const merged = r.commits?.find(c => c.message === 'Merging feature/US-1 to promotion/P1');
    assert.ok(merged, 'the promotion merge is listed');
    assert.equal(merged.offBranch?.target, 'master');
    assert.equal(merged.offBranch?.entry?.from, 'feature/US-2');
    assert.equal(merged.offBranch?.entry?.notCarried, true);
    assert.match(merged.note ?? '', /on its way to master/);
    assert.match(merged.note ?? '', /rbkqa did not get it from this merge\. See .* \(\w{7}\) for when it reached rbkqa\./);
});
