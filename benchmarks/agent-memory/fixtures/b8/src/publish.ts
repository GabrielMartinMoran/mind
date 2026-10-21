// Release publishing helper (fixture).

export interface ReleasePlan {
  readonly version: string;
  readonly dryRun: boolean;
}

export function planRelease(version: string, dryRun = true): ReleasePlan {
  return { version, dryRun };
}

console.log(JSON.stringify(planRelease('0.0.0')));
