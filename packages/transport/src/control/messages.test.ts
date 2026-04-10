/**
 * Message type tests for draft-14 additions.
 *
 * These test that new message types added for draft-14 support are
 * valid members of the ControlMessage union and carry the correct fields.
 *
 * @see draft-ietf-moq-transport-14 §9.24, §9.25, §9.26, §9.27, §9.28, §9.31
 */
import { describe, it, expect } from 'vitest';
import type {
  ControlMessage,
  UnsubscribeNamespace,
  PublishNamespaceOk,
  PublishNamespaceError,
  PublishNamespaceDone,
  PublishNamespaceCancel,
  SubscribeNamespace,
} from './messages.js';
import { varint } from '../primitives/varint.js';

describe('Draft-14 message types', () => {
  /**
   * UNSUBSCRIBE_NAMESPACE — draft-14 §9.31
   *
   * UNSUBSCRIBE_NAMESPACE Message {
   *   Type (i) = 0x14,
   *   Length (16),
   *   Track Namespace Prefix (tuple)
   * }
   */
  it('UnsubscribeNamespace is a valid ControlMessage', () => {
    const enc = new TextEncoder();
    const msg: UnsubscribeNamespace = {
      type: 'UNSUBSCRIBE_NAMESPACE',
      trackNamespacePrefix: [enc.encode('example.com')],
    };
    // Verify it satisfies the union
    const cm: ControlMessage = msg;
    expect(cm.type).toBe('UNSUBSCRIBE_NAMESPACE');
  });

  /**
   * PUBLISH_NAMESPACE_OK — draft-14 §9.24
   *
   * PUBLISH_NAMESPACE_OK Message {
   *   Type (i) = 0x7,
   *   Length (16),
   *   Request ID (i)
   * }
   */
  it('PublishNamespaceOk is a valid ControlMessage', () => {
    const msg: PublishNamespaceOk = {
      type: 'PUBLISH_NAMESPACE_OK',
      requestId: varint(1),
    };
    const cm: ControlMessage = msg;
    expect(cm.type).toBe('PUBLISH_NAMESPACE_OK');
  });

  /**
   * PUBLISH_NAMESPACE_ERROR — draft-14 §9.25
   *
   * PUBLISH_NAMESPACE_ERROR Message {
   *   Type (i) = 0x8,
   *   Length (16),
   *   Request ID (i),
   *   Error Code (i),
   *   Error Reason (Reason Phrase)
   * }
   */
  it('PublishNamespaceError is a valid ControlMessage', () => {
    const msg: PublishNamespaceError = {
      type: 'PUBLISH_NAMESPACE_ERROR',
      requestId: varint(1),
      errorCode: varint(0),
      errorReason: 'internal error',
    };
    const cm: ControlMessage = msg;
    expect(cm.type).toBe('PUBLISH_NAMESPACE_ERROR');
  });

  /**
   * PUBLISH_NAMESPACE_DONE — draft-14 §9.26 uses Track Namespace (tuple),
   * draft-16 §9.22 uses Request ID (i).
   *
   * Draft-14:
   *   PUBLISH_NAMESPACE_DONE { Type (i) = 0x9, Length (16), Track Namespace (tuple) }
   * Draft-16:
   *   PUBLISH_NAMESPACE_DONE { Type (i) = 0x09, Length (16), Request ID (i) }
   */
  it('PublishNamespaceDone supports requestId (draft-16)', () => {
    const msg: PublishNamespaceDone = {
      type: 'PUBLISH_NAMESPACE_DONE',
      requestId: varint(5),
    };
    expect(msg.requestId).toBe(5n);
    expect(msg.trackNamespace).toBeUndefined();
  });

  it('PublishNamespaceDone supports trackNamespace (draft-14)', () => {
    const enc = new TextEncoder();
    const msg: PublishNamespaceDone = {
      type: 'PUBLISH_NAMESPACE_DONE',
      trackNamespace: [enc.encode('live'), enc.encode('stream1')],
    };
    expect(msg.trackNamespace).toHaveLength(2);
    expect(msg.requestId).toBeUndefined();
  });

  /**
   * PUBLISH_NAMESPACE_CANCEL — draft-14 §9.27 uses Track Namespace (tuple),
   * draft-16 §9.24 uses Request ID (i).
   */
  it('PublishNamespaceCancel supports requestId (draft-16)', () => {
    const msg: PublishNamespaceCancel = {
      type: 'PUBLISH_NAMESPACE_CANCEL',
      requestId: varint(5),
      errorCode: varint(0),
      errorReason: 'done',
    };
    expect(msg.requestId).toBe(5n);
    expect(msg.trackNamespace).toBeUndefined();
  });

  it('PublishNamespaceCancel supports trackNamespace (draft-14)', () => {
    const enc = new TextEncoder();
    const msg: PublishNamespaceCancel = {
      type: 'PUBLISH_NAMESPACE_CANCEL',
      trackNamespace: [enc.encode('live')],
      errorCode: varint(0),
      errorReason: 'cancelled',
    };
    expect(msg.trackNamespace).toHaveLength(1);
    expect(msg.requestId).toBeUndefined();
  });

  /**
   * SUBSCRIBE_NAMESPACE — draft-14 §9.28 has no subscribeOptions field.
   * Draft-16 §9.25 added Subscribe Options (i).
   */
  it('SubscribeNamespace allows omitted subscribeOptions (draft-14)', () => {
    const enc = new TextEncoder();
    const msg: SubscribeNamespace = {
      type: 'SUBSCRIBE_NAMESPACE',
      requestId: varint(1),
      trackNamespacePrefix: [enc.encode('example.com')],
      parameters: new Map(),
    };
    expect(msg.subscribeOptions).toBeUndefined();
  });

  it('SubscribeNamespace allows subscribeOptions (draft-16)', () => {
    const enc = new TextEncoder();
    const msg: SubscribeNamespace = {
      type: 'SUBSCRIBE_NAMESPACE',
      requestId: varint(1),
      trackNamespacePrefix: [enc.encode('example.com')],
      subscribeOptions: varint(0),
      parameters: new Map(),
    };
    expect(msg.subscribeOptions).toBe(0n);
  });
});
