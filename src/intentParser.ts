export type IntentType =
    | 'FIND_ADDED'
    | 'FIND_REMOVED'
    | 'FIND_BOTH'
    | 'FULL_HISTORY'
    | 'RECENT_HISTORY'
    | 'SHOW_COMMIT'
    | 'BLAME'
    | 'SEARCH_ALL_BRANCHES';

export interface Intent {
    type: IntentType;
    searchString?: string;
    branch?: string;
    commitHash?: string;
    filePath?: string;
    limit?: number;
    originalQuestion: string;
}

const COMMIT_HASH_RE = /\b([0-9a-f]{7,40})\b/i;
const BRANCH_RE      = /\bon\s+(?:branch\s+)?(\S+)/i;
const SINCE_RE       = /\b(?:in\s+)?(?:the\s+)?(?:last|past)\s+(\d+)\s+(day|week|month)s?\b/i;

const ACTION_WORDS = /\b(?:added|removed|deleted|changed|introduced|committed)\b/i;
const LEADING_RE  = /^(?:when\s+was|who\s+(?:added|removed|deleted|changed)|find|search(?:\s+for)?|track|did\s+(?:anyone|someone\s+)?(?:add|remove|delete|change))\s+/i;
const TRAILING_RE = /\s+(?:was|is|got|has\s+been|were)\s+(?:added|removed|deleted|changed|introduced)\b[\s\S]*$/i;

function extractSearchString(question: string): string | undefined {
    const q = question;

    // 1. Quoted string — highest priority
    const quoted = q.match(/["'`]([^"'`]{2,}?)["'`]/);
    if (quoted) return quoted[1].trim();

    // 2. "<code content> was added/removed" — user pasted a line then action at end
    //    e.g. "MAX( NULLVALUE(ACV__c, 0), 0), was added"
    const trailingAction = q.match(/^([\s\S]+?)\s+(?:was|is|got|has\s+been|were)\s+(?:added|removed|deleted|changed|introduced)\b/i);
    if (trailingAction) {
        const candidate = trailingAction[1].replace(LEADING_RE, '').trim();
        if (candidate.length >= 2) return candidate;
    }

    // 3. "when was <code> added" — leading action words, trailing action verb
    const leadingAction = q.replace(LEADING_RE, '').replace(ACTION_WORDS, '').trim();
    if (leadingAction && leadingAction !== q.trim() && leadingAction.length >= 2) {
        // strip trailing branch qualifiers "on rbkqa" etc.
        return leadingAction.replace(/\s+on\s+\S+$/i, '').trim();
    }

    // 4. Short keyword fallback
    const keywordMatch = q.match(
        /(?:was|is|has|contains?|with|for|about)\s+[`"']?([A-Za-z0-9_.\-:/<>(){}[\], ]{2,80}?)(?:\s+(?:added|removed|deleted|changed|in|on|from|to)\b|$)/i
    );
    if (keywordMatch) return keywordMatch[1].trim();

    return undefined;
}

function extractBranch(q: string): string | undefined {
    const m = q.match(BRANCH_RE);
    return m ? m[1].replace(/[?.,]$/, '') : undefined;
}

function extractLimit(q: string): number | undefined {
    const m = q.match(/(?:last|recent)\s+(\d+)/i);
    return m ? parseInt(m[1], 10) : undefined;
}

export function parseIntent(question: string, activeFilePath?: string): Intent {
    const q       = question.toLowerCase().trim();
    const branch  = extractBranch(question);
    const search  = extractSearchString(question);
    const limit   = extractLimit(question);
    const hashM   = question.match(COMMIT_HASH_RE);
    const hash    = hashM ? hashM[1] : undefined;

    const base: Omit<Intent, 'type'> = {
        searchString:   search,
        branch,
        commitHash:     hash,
        filePath:       activeFilePath,
        limit,
        originalQuestion: question,
    };

    // BLAME
    if (/\bblame\b|\bwho\s+wrote\b|\bwho\s+authored\b|\bwho\s+owns\b/.test(q)) {
        return { ...base, type: 'BLAME' };
    }

    // SHOW COMMIT
    if (hash && (/\bshow\b|\bwhat\s+changed\b|\bdetails?\b|\bwhat\s+is\b/.test(q) || q.startsWith('show') || q.startsWith('what'))) {
        return { ...base, type: 'SHOW_COMMIT' };
    }

    // FIND ADDED
    if (/\badded\b/.test(q) && !/\bremoved\b|\bdeleted\b/.test(q)) {
        return { ...base, type: 'FIND_ADDED' };
    }

    // FIND REMOVED
    if (/\bremoved\b|\bdeleted\b/.test(q) && !/\badded\b/.test(q)) {
        return { ...base, type: 'FIND_REMOVED' };
    }

    // FIND BOTH (added & removed / full line trail)
    if ((/\badded\b/.test(q) && /\bremoved\b|\bdeleted\b/.test(q)) ||
        /\bhistory\s+of\s+(?:this\s+)?(?:line|string|text|code)\b/.test(q) ||
        /\bwhen\s+(?:was|did)\b.*\bchange\b/.test(q)) {
        return { ...base, type: 'FIND_BOTH' };
    }

    // SEARCH ALL BRANCHES
    if (/\ball\s+branches?\b|\bacross\s+branches?\b|\beverywhere\b/.test(q)) {
        return { ...base, type: 'SEARCH_ALL_BRANCHES' };
    }

    // RECENT HISTORY (short list)
    if (/\brecent\b|\blatest\b|\blast\s+\d+\b|\bwho\s+(?:last\s+)?changed\b|\bwho\s+touched\b|\bwho\s+modified\b/.test(q)) {
        return { ...base, type: 'RECENT_HISTORY', limit: limit ?? 10 };
    }

    // Full history (default when search string present = FIND_BOTH, else FULL_HISTORY)
    if (search) {
        return { ...base, type: 'FIND_BOTH' };
    }

    return { ...base, type: 'FULL_HISTORY' };
}

export function describeIntent(intent: Intent): string {
    switch (intent.type) {
        case 'FIND_ADDED':
            return `Finding when "${intent.searchString}" was ADDED${intent.branch ? ` on ${intent.branch}` : ''}`;
        case 'FIND_REMOVED':
            return `Finding when "${intent.searchString}" was REMOVED${intent.branch ? ` on ${intent.branch}` : ''}`;
        case 'FIND_BOTH':
            return `Tracing full history of "${intent.searchString}"${intent.branch ? ` on ${intent.branch}` : ''}`;
        case 'FULL_HISTORY':
            return `Showing full commit history of this file${intent.branch ? ` on ${intent.branch}` : ''}`;
        case 'RECENT_HISTORY':
            return `Showing last ${intent.limit ?? 10} commits for this file`;
        case 'SHOW_COMMIT':
            return `Showing details of commit ${intent.commitHash}`;
        case 'BLAME':
            return `Showing who wrote each line (git blame)`;
        case 'SEARCH_ALL_BRANCHES':
            return `Searching across all branches for "${intent.searchString}"`;
        default:
            return 'Running git query...';
    }
}
