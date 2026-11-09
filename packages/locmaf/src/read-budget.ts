export interface LocmafReadBudgetLimits {
    readonly maxSamples: number;
    readonly maxEntries: number;
    readonly maxBytes: number;
}

export interface LocmafReadBudgetUsage {
    readonly samples: number;
    readonly entries: number;
    readonly bytes: number;
}

/** A local resource refusal, not malformed LOCMAF or a protocol violation. */
export class LocmafReadLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LocmafReadLimitError';
    }
}

/** Cumulative allocation allowances for one caller-owned read operation. */
export class LocmafReadBudget {
    private readonly limits: LocmafReadBudgetUsage;
    private readonly used = { samples: 0, entries: 0, bytes: 0 };

    constructor(options: Readonly<LocmafReadBudgetLimits>) {
        const { maxSamples, maxEntries, maxBytes } = options;
        for (const limit of [maxSamples, maxEntries, maxBytes]) {
            if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('LOCMAF read limits must be positive safe integers');
        }
        this.limits = Object.freeze({ samples: maxSamples, entries: maxEntries, bytes: maxBytes });
    }

    /** Check remaining sample capacity without reserving it. */
    checkSamples(count: number): void { this.check('samples', count); }

    claimSamples(count: number): void {
        this.checkSamples(count);
        this.used.samples += count;
    }

    claimEntries(count: number): void {
        this.check('entries', count);
        this.used.entries += count;
    }

    claimBytes(count: number): void {
        this.check('bytes', count);
        this.used.bytes += count;
    }

    get usage(): LocmafReadBudgetUsage { return Object.freeze({ ...this.used }); }

    private check(kind: keyof LocmafReadBudgetUsage, count: number): void {
        if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('LOCMAF read claims must be non-negative safe integers');
        if (count > this.limits[kind] - this.used[kind]) throw new LocmafReadLimitError(`LOCMAF read ${kind} budget exceeded`);
    }
}
