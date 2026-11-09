import type { SourceTimestamp } from '@openmoq/loc';
import type { FractionUs } from './presentation-placement.js';

/** Feasible contentUs - sourceUs offsets; the lower endpoint is inclusive. */
export interface LocTimelineMappingState {
  readonly domain: 'media' | 'unix';
  readonly lowerUs: FractionUs;
  readonly upperUs: FractionUs;
  readonly upperInclusive: boolean;
}

/** The observed anchors cannot support this unit-rate profile. */
export class UnsupportedLocTimelineMappingError extends Error {
  constructor(message = 'Unsupported LOC unit-rate mapping') {
    super(message);
    this.name = 'UnsupportedLocTimelineMappingError';
  }
}

function fraction(numerator: bigint, denominator: bigint): FractionUs {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint' || denominator <= 0n) {
    throw new TypeError('Invalid LOC mapping fraction');
  }
  let a = numerator < 0n ? -numerator : numerator, b = denominator;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  const divisor = a || 1n;
  return Object.freeze({ numerator: numerator / divisor, denominator: denominator / divisor });
}

function snapshotFraction(value: FractionUs): FractionUs {
  const { numerator, denominator } = value;
  return fraction(numerator, denominator);
}

function compare(a: FractionUs, b: FractionUs): bigint {
  return a.numerator * b.denominator - b.numerator * a.denominator;
}

function mapping(domain: LocTimelineMappingState['domain'], lowerUs: FractionUs,
  upperUs: FractionUs, upperInclusive: boolean): LocTimelineMappingState {
  const order = compare(lowerUs, upperUs);
  if (order > 0n || (order === 0n && !upperInclusive)) throw new UnsupportedLocTimelineMappingError('LOC unit-rate mapping offset intersection is empty');
  return Object.freeze({ domain, lowerUs, upperUs, upperInclusive });
}

/** Copy and validate resumed state without retaining caller objects or getters. */
export function snapshotLocTimelineMapping(value: LocTimelineMappingState): LocTimelineMappingState {
  const { domain, lowerUs, upperUs, upperInclusive } = value;
  if (domain !== 'media' && domain !== 'unix') throw new UnsupportedLocTimelineMappingError('LOC unit-rate mapping source domain is unsupported');
  if (typeof upperInclusive !== 'boolean') throw new TypeError('Invalid LOC mapping upper endpoint');
  const lower = snapshotFraction(lowerUs), upper = snapshotFraction(upperUs);
  return mapping(domain, lower, upper, upperInclusive);
}

/** Constrain offsets using an exact indexed sample; matching and ownership are caller policy. */
export function constrainLocTimelineMapping(state: LocTimelineMappingState | undefined,
  source: SourceTimestamp, mediaPts: number, rounding: 'floor' | 'nearest'): LocTimelineMappingState {
  const previous = state === undefined ? undefined : snapshotLocTimelineMapping(state);
  const { ticks, ticksPerSecond, domain } = source;
  if (typeof ticks !== 'bigint' || typeof ticksPerSecond !== 'bigint' || ticksPerSecond <= 0n) {
    throw new TypeError('Invalid LOC mapping source timestamp');
  }
  if (domain !== 'media' && domain !== 'unix') throw new UnsupportedLocTimelineMappingError('LOC unit-rate mapping source domain is unsupported');
  if (previous && previous.domain !== domain) throw new UnsupportedLocTimelineMappingError('LOC unit-rate mapping source domain changed');
  if (!Number.isSafeInteger(mediaPts)) throw new RangeError('LOC mapping requires integral safe media milliseconds');
  if (rounding !== 'floor' && rounding !== 'nearest') throw new TypeError('Invalid LOC mapping timestamp rounding');
  const center = BigInt(mediaPts) * 1000n * ticksPerSecond - ticks * 1_000_000n;
  const lower = fraction(center - (rounding === 'nearest' ? 500n * ticksPerSecond : 0n), ticksPerSecond);
  const upper = fraction(center + (rounding === 'nearest' ? 500n : 1000n) * ticksPerSecond, ticksPerSecond);
  const inclusive = rounding === 'nearest';
  if (!previous) return mapping(domain, lower, upper, inclusive);
  const lowerUs = compare(previous.lowerUs, lower) >= 0n ? previous.lowerUs : lower;
  const upperOrder = compare(previous.upperUs, upper);
  const upperUs = upperOrder <= 0n ? previous.upperUs : upper;
  const upperInclusive = upperOrder < 0n ? previous.upperInclusive
    : upperOrder > 0n ? inclusive : previous.upperInclusive && inclusive;
  return mapping(domain, lowerUs, upperUs, upperInclusive);
}
