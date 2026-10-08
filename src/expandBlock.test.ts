import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countOccurrences, expandToUniqueBlock } from './expandBlock';

// Two related lists share the line <fields>NAME</fields>; each also has a line only it has.
const layout = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Layout xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <relatedLists>',
    '        <fields>NAME</fields>',
    '        <fields>Quote__c</fields>',
    '        <relatedList>CPQ_Quote_Rate_Card__c.Account__c</relatedList>',
    '    </relatedLists>',
    '    <relatedLists>',
    '        <fields>NAME</fields>',
    '        <fields>UPDATEDBY_USER</fields>',
    '        <relatedList>Account_Extension__c.Account__c</relatedList>',
    '    </relatedLists>',
    '</Layout>',
];

test('the repeated NAME line expands to the related list around the cursor, and picks the right one', () => {
    assert.deepEqual(expandToUniqueBlock(layout, 3), { start: 2, end: 6 });    // NAME of the first list
    assert.deepEqual(expandToUniqueBlock(layout, 8), { start: 7, end: 11 });   // NAME of the second list
});

test('a line that starts or ends an element expands to that element', () => {
    assert.deepEqual(expandToUniqueBlock(layout, 2), { start: 2, end: 6 });
    assert.deepEqual(expandToUniqueBlock(layout, 11), { start: 7, end: 11 });
});

test('keeps widening to the parent while the block is still repeated', () => {
    const doc = [
        '<Layout>',
        '  <layoutSections>',
        '    <label>Address</label>',
        '    <layoutItems>',
        '      <behavior>Edit</behavior>',
        '      <field>Name</field>',
        '    </layoutItems>',
        '  </layoutSections>',
        '  <layoutSections>',
        '    <label>Contact</label>',
        '    <layoutItems>',
        '      <behavior>Edit</behavior>',
        '      <field>Name</field>',
        '    </layoutItems>',
        '  </layoutSections>',
        '</Layout>',
    ];
    // the layoutItems element is identical in both sections, so it must widen to the section
    assert.deepEqual(expandToUniqueBlock(doc, 5), { start: 1, end: 7 });
    assert.deepEqual(expandToUniqueBlock(doc, 12), { start: 8, end: 14 });
});

test('gives up (undefined) when nothing around the line is unique, or when the block is too big', () => {
    const same = ['<A>', '<B>', '<x>1</x>', '</B>', '</A>', '<A>', '<B>', '<x>1</x>', '</B>', '</A>'];
    assert.equal(expandToUniqueBlock(same, 2, 200, 1), undefined);
    assert.equal(expandToUniqueBlock(layout, 3, 3), undefined);   // the unique block has 5 lines, more than the limit of 3
    assert.equal(expandToUniqueBlock(['no xml here', 'at all'], 0), undefined);
});

test('countOccurrences counts consecutive matches', () => {
    assert.equal(countOccurrences(['a', 'b', 'a', 'b', 'c'], ['a', 'b']), 2);
    assert.equal(countOccurrences(['a', 'b'], ['b', 'a']), 0);
    assert.equal(countOccurrences(['a'], []), 0);
});
