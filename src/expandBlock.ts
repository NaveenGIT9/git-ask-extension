// For XML metadata files: given the line the user selected, find the smallest enclosing element whose text appears only
// once in the file. For example, the line "<fields>NAME</fields>" is repeated in dozens of related lists, but the
// "<relatedLists> ... </relatedLists>" element around it also holds a line that only that list has, so the whole element
// identifies which NAME line was meant.

export interface BlockRange {
    /** 0-based, inclusive */
    start: number;
    end: number;
}

// <tag> or <tag attr="x"> on a line of its own (not self-closing, not <?xml ...?>)
const OPEN = /^<([A-Za-z_][\w:.-]*)(?:\s[^<>]*)?>$/;
const CLOSE = /^<\/([A-Za-z_][\w:.-]*)>$/;
const isOpen = (t: string): boolean => OPEN.test(t) && !t.endsWith('/>');
const isClose = (t: string): boolean => CLOSE.test(t);

/** How many times the lines in `pattern` appear one after the other in `lines` (both already trimmed). */
export function countOccurrences(lines: string[], pattern: string[]): number {
    if (pattern.length === 0) return 0;
    let n = 0;
    for (let i = 0; i + pattern.length <= lines.length; i++) {
        let match = true;
        for (let k = 0; k < pattern.length; k++) {
            if (lines[i + k] !== pattern[k]) { match = false; break; }
        }
        if (match) n++;
    }
    return n;
}

// The nearest opening line above `from` whose element is still open at `from`.
function parentStart(t: string[], from: number): number | undefined {
    let depth = 0;
    for (let k = from - 1; k >= 0; k--) {
        if (isClose(t[k])) depth++;
        else if (isOpen(t[k])) {
            if (depth === 0) return k;
            depth--;
        }
    }
    return undefined;
}

// The closing line of the element that opens at `start`.
function matchingEnd(t: string[], start: number): number | undefined {
    let depth = 0;
    for (let k = start + 1; k < t.length; k++) {
        if (isOpen(t[k])) depth++;
        else if (isClose(t[k])) {
            if (depth === 0) return k;
            depth--;
        }
    }
    return undefined;
}

// The element around line `i`: the element that starts on it, ends on it, or otherwise the one that contains it.
function elementAround(t: string[], i: number): BlockRange | undefined {
    let start: number | undefined;
    if (isOpen(t[i])) start = i;
    else if (isClose(t[i])) {
        let depth = 1;
        for (let k = i - 1; k >= 0; k--) {
            if (isClose(t[k])) depth++;
            else if (isOpen(t[k]) && --depth === 0) { start = k; break; }
        }
    } else start = parentStart(t, i);
    if (start === undefined) return undefined;
    const end = matchingEnd(t, start);
    return end === undefined ? undefined : { start, end };
}

/**
 * The smallest element around `cursorLine` (0-based) whose lines appear only once in the file, widening to the parent
 * element until it does. Undefined when none is found within `maxSteps` levels or `maxLines` lines.
 */
export function expandToUniqueBlock(rawLines: string[], cursorLine: number, maxLines = 200, maxSteps = 6): BlockRange | undefined {
    const t = rawLines.map((l) => l.trim());
    let range = elementAround(t, cursorLine);
    for (let step = 0; step < maxSteps; step++) {
        if (!range || range.end - range.start + 1 > maxLines) return undefined;
        if (countOccurrences(t, t.slice(range.start, range.end + 1)) === 1) return range;
        const p = parentStart(t, range.start);
        const e = p === undefined ? undefined : matchingEnd(t, p);
        if (p === undefined || e === undefined) return undefined;
        range = { start: p, end: e };
    }
    return undefined;
}
