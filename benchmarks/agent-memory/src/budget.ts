// Cost accumulator with a hard cap.
//
// The benchmark must never spend more than an explicitly approved budget. A
// single `BudgetGuard` is created per run and every paid stage calls
// `assertCanSpend` before sending a prompt and `addCost` after each response.
// The guard is pure (no I/O): it only tracks numbers and throws typed errors.

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    public readonly maxCostUsd: number | null,
    public readonly spentUsd: number
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export interface CostEntry {
  readonly label: string;
  readonly usd: number;
}

export interface BudgetGuardOptions {
  /** Hard cap in USD; `null` refuses any positive spend. */
  readonly maxCostUsd: number | null;
}

export class BudgetGuard {
  readonly maxCostUsd: number | null;
  private readonly _entries: CostEntry[] = [];
  private _spentUsd = 0;
  private _aborted = false;
  private _abortReason: string | null = null;

  constructor(options: BudgetGuardOptions) {
    this.maxCostUsd = options.maxCostUsd;
  }

  get spentUsd(): number {
    return this._spentUsd;
  }

  get remainingUsd(): number | null {
    if (this.maxCostUsd === null) return null;
    return Math.max(0, this.maxCostUsd - this._spentUsd);
  }

  get entries(): readonly CostEntry[] {
    return this._entries;
  }

  get aborted(): boolean {
    return this._aborted;
  }

  get abortReason(): string | null {
    return this._abortReason;
  }

  // Refuse to proceed when the estimated cost would cross the cap. Free stages
  // (estimated 0) always pass, even without an approved budget.
  assertCanSpend(estimatedUsd = 0): void {
    if (this._aborted) {
      throw new BudgetExceededError(
        `budget aborted: ${this._abortReason ?? 'unknown reason'}`,
        this.maxCostUsd,
        this._spentUsd
      );
    }
    if (estimatedUsd <= 0) return;
    if (this.maxCostUsd === null) {
      throw new BudgetExceededError(
        'no budget approved: paid stages require an explicit --budget cap',
        null,
        this._spentUsd
      );
    }
    if (this._spentUsd + estimatedUsd > this.maxCostUsd) {
      throw new BudgetExceededError(
        `budget cap exceeded: spent ${this._spentUsd} + estimated ${estimatedUsd} > cap ${this.maxCostUsd}`,
        this.maxCostUsd,
        this._spentUsd
      );
    }
  }

  // Record actual cost. Crossing the cap after the fact aborts the guard and
  // throws so the caller stops the run immediately.
  addCost(usd: number, label = 'cost'): void {
    this.assertCanSpend(usd);
    this._entries.push({ label, usd });
    this._spentUsd += usd;
  }

  // Mark the guard aborted without adding cost (e.g. external failure).
  abort(reason: string): void {
    this._aborted = true;
    this._abortReason = reason;
  }
}
