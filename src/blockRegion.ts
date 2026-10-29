export interface BlockRegion { score: number; lines: Set<string> }

// Finds where a block sits in a file: spans that start at a line equal to the block's first line and end at the
// next line equal to its last, scored by how many of the block's distinct lines they contain. The best span wins.
// This is what tells apart "<fields>NAME</fields> inside THIS related list" from the same line in all the others.
// anchors: lines the span must contain to count at all. Without them, a sibling block that shares most of its lines
// (e.g. another field's <fieldPermissions> with the same <editable>/<readable>) would be taken for this one.
export function bestBlockRegion(fileLines: string[], block: string[], approxLine?: number, anchors: string[] = []): BlockRegion | undefined {
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
        if (!anchors.every(a => lines.has(a))) continue;
        const score = distinct.filter(l => lines.has(l)).length;
        const nearer = best && approxLine !== undefined && Math.abs(i + 1 - approxLine) < Math.abs(best.start + 1 - approxLine);
        if (!best || score > best.score || (score === best.score && nearer)) best = { score, lines, start: i };
    }
    const needed = Math.max(2, Math.ceil(distinct.length * 0.6));
    return best && best.score >= needed ? { score: best.score, lines: best.lines } : undefined;
}

// The lines that identify which copy of a block is meant when one of its lines (focus) is traced: the block's lines that
// occur exactly once in the file. With none of those, every other line of the block has to be there.
export function anchorLines(fileLines: string[], block: string[], focus: string): string[] {
    const others = [...new Set(block)].filter(l => l !== '' && l !== focus);
    const counts = new Map<string, number>();
    for (const l of fileLines) if (others.includes(l)) counts.set(l, (counts.get(l) ?? 0) + 1);
    const unique = others.filter(l => counts.get(l) === 1);
    return unique.length > 0 ? unique : others;
}
