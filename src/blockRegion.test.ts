import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorLines, bestBlockRegion } from './blockRegion';

const perm = (field: string, editable: string, readable?: string): string[] => [
    '<fieldPermissions>',
    `<editable>${editable}</editable>`,
    `<field>${field}</field>`,
    ...(readable ? [`<readable>${readable}</readable>`] : []),
    '</fieldPermissions>',
];

const block = perm('sbaa__Approval__c.Approval_Type__c', 'false', 'true');
const READABLE = '<readable>true</readable>';

test('the field line is the anchor that identifies which <fieldPermissions> copy is meant', () => {
    const tip = [...perm('CPQ_Rate_Card__c.Previous_Version__c', 'false', 'true'), ...block, ...perm('Account.Name', 'true', 'true')];
    assert.deepEqual(anchorLines(tip, block, READABLE), ['<field>sbaa__Approval__c.Approval_Type__c</field>']);
});

test('with the anchor, another field\'s block is never taken for this one', () => {
    const older = [...perm('CPQ_Rate_Card__c.Previous_Version__c', 'false', 'true')];
    // Without anchors the other field's block shares 4 of 5 lines and is accepted.
    assert.ok(bestBlockRegion(older, block));
    // With the anchor it is not: this field's block is simply not in that revision.
    assert.equal(bestBlockRegion(older, block, undefined, ['<field>sbaa__Approval__c.Approval_Type__c</field>']), undefined);
});

test('the right block is found, and tells whether it held the readable line at that revision', () => {
    const anchors = ['<field>sbaa__Approval__c.Approval_Type__c</field>'];
    const without = [...perm('CPQ_Rate_Card__c.Previous_Version__c', 'false', 'true'), ...perm('sbaa__Approval__c.Approval_Type__c', 'false')];
    const r1 = bestBlockRegion(without, block, undefined, anchors);
    assert.ok(r1);
    assert.equal(r1.lines.has(READABLE), false);

    const withIt = [...perm('CPQ_Rate_Card__c.Previous_Version__c', 'false', 'true'), ...block];
    const r2 = bestBlockRegion(withIt, block, undefined, anchors);
    assert.ok(r2);
    assert.equal(r2.lines.has(READABLE), true);
});

test('with no unique line in the block, all its other lines are required', () => {
    const twice = [...block, ...block];
    assert.deepEqual(anchorLines(twice, block, READABLE).sort(), [
        '</fieldPermissions>', '<editable>false</editable>', '<field>sbaa__Approval__c.Approval_Type__c</field>', '<fieldPermissions>',
    ].sort());
});
