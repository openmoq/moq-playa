/**
 * Session action type tests for draft-14 additions.
 *
 * Tests that the NotifyNamespaceAction is a valid SessionOutboundAction
 * member, used to bridge draft-14 namespace events from the control stream
 * to the adapter's onNamespaceMessage callback.
 *
 * @see draft-ietf-moq-transport-14 §9.23 (PUBLISH_NAMESPACE on control stream)
 */
import { describe, it, expect } from 'vitest';
import type {
  SessionOutboundAction,
  NotifyNamespaceAction,
} from './types.js';
import type { ControlMessage } from '../control/messages.js';
import { varint } from '../primitives/varint.js';

describe('Draft-14 action types', () => {
  it('NotifyNamespaceAction is a valid SessionOutboundAction', () => {
    const enc = new TextEncoder();
    const nsMsg: ControlMessage = {
      type: 'PUBLISH_NAMESPACE',
      requestId: varint(3),
      trackNamespace: [enc.encode('live'), enc.encode('broadcast')],
      parameters: new Map(),
    };

    const action: NotifyNamespaceAction = {
      type: 'notify_namespace',
      requestId: varint(1),
      message: nsMsg,
    };

    // Verify it satisfies the union
    const outbound: SessionOutboundAction = action;
    expect(outbound.type).toBe('notify_namespace');
  });
});
