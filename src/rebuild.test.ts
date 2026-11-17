import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envTarget, findRebuildPoint, FirstParentCommit } from './rebuild';

test('envTarget names environment branches only', () => {
    assert.equal(envTarget('Merging promotion/P33566 into rbkqa after auto conflict resolution'), 'rbkqa');
    assert.equal(envTarget("Merge branch 'feature/US-0028283' into rbkuat"), 'rbkuat');
    assert.equal(envTarget('Sync: merge rbkqa into rbkintslmk via sync/x'), 'rbkintslmk');
    assert.equal(envTarget('Merging feature/US-1 to promotion/P2'), undefined);
    assert.equal(envTarget('Adding Captello_User PS back'), undefined);
});

let n = 0;
const c = (subject: string): FirstParentCommit => ({ hash: `h${++n}`, ts: 1000 - n, subject });

test('finds where rbkqa restarted from rbkuat', () => {
    const fp = [
        c('Adding Captello_User PS back'),
        c('Merging promotion/P2 into rbkqa'),
        c('Merging feature/US-1 to promotion/P2'),
        c('Merging promotion/P1 into rbkqa'),
        c('Merging feature/US-0 to promotion/P1'),
        c('Merging promotion/U3 into rbkuat'),
        c('Merging promotion/U2 into rbkuat'),
        c("Merge branch 'feature/US-9' into rbkuat"),
        c('Merging promotion/U1 into rbkuat'),
    ];
    const rb = findRebuildPoint(fp, 'rbkqa');
    assert.ok(rb);
    assert.equal(rb.from, 'rbkuat');
    // rbkuat's tip; the promotion commits built on it for rbkqa are rbkqa's own work.
    assert.equal(rb.takenHash, fp[5].hash);
    assert.equal(rb.restartHash, fp[3].hash);
});

test('a normal branch with an odd foreign merge is not a rebuild', () => {
    const fp = [
        c('Merging promotion/P3 into rbkqa'),
        c("Merge branch 'rbkhotfix' into rbkuat"),
        c('Merging promotion/P2 into rbkqa'),
        c('Merging promotion/P1 into rbkqa'),
    ];
    assert.equal(findRebuildPoint(fp, 'rbkqa'), undefined);
});

test('a branch with only its own merges is not a rebuild', () => {
    const fp = [c('Merging promotion/P2 into rbkqa'), c('Merging promotion/P1 into rbkqa')];
    assert.equal(findRebuildPoint(fp, 'rbkqa'), undefined);
});
