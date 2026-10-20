// Range helper (fixture). NOTE: this fixture intentionally ships a bug — the
// bounds are meant to be inclusive but the comparisons are strict.

export function isInRange(value: number, min: number, max: number): boolean {
  return value > min && value < max;
}
