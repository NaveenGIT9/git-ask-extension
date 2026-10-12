import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { listBranchRefs, orderLocal, orderRemote } from './branches';

const dir = mkdtempSync(join(tmpdir(), 'gitask-branches-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });

git('init', '-q', '-b', 'master');
git('commit', '-q', '--allow-empty', '-m', 'init');
git('branch', 'rbkuat');
git('branch', 'promotion/P34277');
git('update-ref', 'refs/remotes/origin/rbkuat', 'HEAD');
git('update-ref', 'refs/remotes/origin/rbkqa', 'HEAD');
git('update-ref', 'refs/remotes/origin/promotion/P34100', 'HEAD');
git('update-ref', 'refs/remotes/origin/promotion/P34277', 'HEAD');
git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/rbkuat');
git('switch', '-q', 'promotion/P34277');

test('local branches keep their plain names and remote ones carry the remote prefix', () => {
    const { local, remote, current } = listBranchRefs(dir);
    assert.deepEqual(local.map((b) => b.label).sort(), ['master', 'promotion/P34277', 'rbkuat']);
    assert.deepEqual(remote.map((b) => b.label).sort(), ['origin/promotion/P34100', 'origin/promotion/P34277', 'origin/rbkqa', 'origin/rbkuat']);
    assert.ok(local.every((b) => b.kind === 'local' && b.ref === `refs/heads/${b.label}`));
    assert.ok(remote.every((b) => b.kind === 'remote' && b.ref === `refs/remotes/${b.label}`));
    assert.equal(current, 'promotion/P34277');
});

test('the same name exists as two different entries: local "rbkuat" and remote "origin/rbkuat"', () => {
    const { local, remote } = listBranchRefs(dir);
    assert.ok(local.some((b) => b.label === 'rbkuat'));
    assert.ok(remote.some((b) => b.label === 'origin/rbkuat'));
    assert.ok(!remote.some((b) => b.label === 'origin/HEAD'), 'origin/HEAD is not a branch');
});

test('ordering: checked-out branch first, then environment-style names, then the rest', () => {
    const { local, remote, current } = listBranchRefs(dir);
    assert.deepEqual(orderLocal(local, current).map((b) => b.label), ['promotion/P34277', 'master', 'rbkuat']);
    assert.deepEqual(orderRemote(remote).map((b) => b.label), ['origin/rbkqa', 'origin/rbkuat', 'origin/promotion/P34277', 'origin/promotion/P34100']);
});

test('outside a git repository the list is empty instead of throwing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'gitask-norepo-'));
    try {
        assert.deepEqual(listBranchRefs(empty), { local: [], remote: [] });
    } finally {
        rmSync(empty, { recursive: true, force: true });
    }
});
