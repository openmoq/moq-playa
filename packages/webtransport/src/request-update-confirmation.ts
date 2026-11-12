/** A local update failure: only not-sent proves the peer could not apply it. */
export class RequestUpdateFailure extends Error {
  constructor(readonly disposition: 'not-sent' | 'possibly-sent', readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : 'RequestUpdateFailure';
  }
}

/** The matching wire REQUEST_ERROR, preserving its full-width error code. */
export class RequestUpdateError extends RequestUpdateFailure {
  constructor(readonly requestId: bigint, readonly errorCode: bigint,
    readonly errorReason: string, readonly retryInterval: bigint) {
    super('possibly-sent', new Error(errorReason));
    this.name = 'RequestUpdateError';
  }
}
