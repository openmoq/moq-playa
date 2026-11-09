export interface FractionUs {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface PresentationPlacement {
  readonly token: object;
  toRebasedTimeUs(sourcePresentationTimeUs: bigint): FractionUs | null;
}

function fraction(numerator: bigint, denominator: bigint): FractionUs {
  let a = numerator < 0n ? -numerator : numerator, b = denominator;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  const divisor = a || 1n;
  return Object.freeze({ numerator: numerator / divisor, denominator: denominator / divisor });
}

/** Preserve the actual finite native double; do not round offsets before target-tick conversion. */
export function nativeTimeUs(seconds: number | undefined): FractionUs | null {
  if (seconds === undefined || !Number.isFinite(seconds)) return null;
  if (seconds === 0) return fraction(0n, 1n);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, seconds);
  const bits = view.getBigUint64(0), exponent = Number((bits >> 52n) & 0x7ffn);
  const mantissa = (bits & ((1n << 52n) - 1n)) + (exponent === 0 ? 0n : 1n << 52n);
  const shift = (exponent === 0 ? -1022 : exponent - 1023) - 52;
  const numerator = (bits >> 63n ? -mantissa : mantissa) * 1_000_000n;
  return shift >= 0 ? fraction(numerator << BigInt(shift), 1n)
    : fraction(numerator, 1n << BigInt(-shift));
}

/**
 * Native range readback policy, not an exact coded-coverage proof. Separately
 * quantized presentation times and durations can lose nearly two microseconds.
 * Allow that conversion loss plus one binary64 endpoint ULP, only while that
 * ULP is at most one microsecond. Coded joins and sample floors stay exact.
 */
export function nativeRangeMayReachBoundary(endSeconds: number, boundaryUs: FractionUs): boolean {
  const end = nativeTimeUs(endSeconds);
  if (!end || endSeconds < 0 || boundaryUs.denominator <= 0n || boundaryUs.numerator < 0n) return false;
  const shortfall = boundaryUs.numerator * end.denominator - end.numerator * boundaryUs.denominator;
  if (shortfall <= 0n) return true;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, endSeconds === 0 ? 0 : endSeconds);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  const ulp = nativeTimeUs(view.getFloat64(0) - endSeconds);
  if (!ulp || ulp.numerator <= 0n || ulp.numerator > ulp.denominator) return false;
  const allowance = 2n * ulp.denominator + ulp.numerator;
  return shortfall * ulp.denominator <= allowance * boundaryUs.denominator * end.denominator;
}

/**
 * Place a target on the reference output's element timeline. Token validation
 * belongs to the operation owner before adoption; this helper only composes
 * captured evidence. The target assembler performs the one tick-rounding step.
 */
export function placePresentationAnchor(
  reference: PresentationPlacement, sourceTimeUs: bigint, referenceTimeUs: bigint,
  referenceOffsetSeconds: number | undefined, targetOffsetSeconds: number | undefined,
): { readonly sourceTimeUs: bigint; readonly rebasedTimeUs: FractionUs } | null {
  if (typeof sourceTimeUs !== 'bigint' || typeof referenceTimeUs !== 'bigint') throw new TypeError('Expected bigint presentation anchors');
  const referenceOffset = nativeTimeUs(referenceOffsetSeconds), targetOffset = nativeTimeUs(targetOffsetSeconds);
  if (!referenceOffset || !targetOffset) return null;
  const placed = reference.toRebasedTimeUs(referenceTimeUs);
  if (placed === null) return null;
  const { numerator, denominator } = placed;
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint' || denominator <= 0n) {
    throw new TypeError('Invalid reference presentation placement');
  }
  const rebasedTimeUs = fraction(
    numerator * referenceOffset.denominator * targetOffset.denominator
      + referenceOffset.numerator * denominator * targetOffset.denominator
      - targetOffset.numerator * denominator * referenceOffset.denominator,
    denominator * referenceOffset.denominator * targetOffset.denominator,
  );
  return Object.freeze({ sourceTimeUs, rebasedTimeUs });
}
