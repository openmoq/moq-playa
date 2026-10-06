import { decodeParameterSequence, DRAFT22_MESSAGE_PARAM_REGISTRY, type MessageParams18 } from './message-params-18.js';
import { decodeSubscriptionFilter, subscriptionWindow, type SubscriptionFilter, type SubscriptionWindow } from './subscription-filter.js';
import type { GroupOrder } from '../data/types.js';
import { ProtocolViolationError } from '../errors.js';

/** Per-message overrides; omitted values inherit the subscription (9.20.15). */
export interface FillOptions {
  readonly filter?: SubscriptionFilter;
  readonly groupOrder?: GroupOrder;
}

const allowed = new Set([0x0an, 0x20n, 0x21n, 0x22n, 0x25n, 0x26n, 0x27n, 0x28n]);
const repeatable = new Set([0x25n, 0x26n, 0x27n, 0x28n]);

export function decodeFillParameters(bytes: Uint8Array): FillOptions & { parameters: MessageParams18 } {
  const parameters = decodeParameterSequence(bytes, DRAFT22_MESSAGE_PARAM_REGISTRY);
  const result: { filter?: SubscriptionFilter; groupOrder?: GroupOrder; parameters: MessageParams18 } = { parameters };
  for (const [type, values] of parameters) {
    if (!allowed.has(type)) throw new ProtocolViolationError(`Parameter 0x${type.toString(16)} is not allowed in FILL_PARAMETERS (9.20.15)`);
    if (!repeatable.has(type) && values.length > 1) throw new ProtocolViolationError(`Duplicate fill parameter 0x${type.toString(16)}`);
    const value = values[0]!;
    if (type === 0x21n && value.kind === 'locationFilter') result.filter = decodeSubscriptionFilter(value.value, 22);
    if (type === 0x22n && value.kind === 'uint8') {
      if (value.value !== 1 && value.value !== 2) throw new ProtocolViolationError('Fill GROUP_ORDER must be 1 or 2');
      result.groupOrder = value.value === 2 ? 'descending' : 'ascending';
    }
  }
  return result;
}

/** A fill is bounded by the Largest Object in its own response (3.4). */
export function resolveFillWindow(
  filter: SubscriptionFilter | undefined,
  largest: { group: bigint; object: bigint } | undefined,
): SubscriptionWindow | null {
  if (!largest) return null;
  const window = subscriptionWindow(filter, largest);
  let end = largest;
  if (window.end && (window.end.group < largest.group
      || (window.end.group === largest.group && window.end.object !== undefined && window.end.object < largest.object))) {
    end = { group: window.end.group, object: window.end.object ?? 0xffffffffffffffffn };
  }
  if (window.start.group > end.group || (window.start.group === end.group && window.start.object > end.object)) return null;
  return { start: window.start, end };
}
