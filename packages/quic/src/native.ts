/** Internal structural types for Node's experimental `node:quic` API. */

export interface NativeQuicOpenedInfo {
  readonly protocol: string;
  readonly earlyDataAttempted: boolean;
  readonly earlyDataAccepted: boolean;
  readonly validationErrorReason?: string;
  readonly validationErrorCode?: number | string;
}

export interface NativeQuicWriter {
  readonly canWrite?: boolean | null;
  write(chunk: Uint8Array): Promise<unknown>;
  end(): Promise<unknown>;
  fail(reason?: unknown): void;
}

export interface NativeQuicStream extends AsyncIterable<Uint8Array[]> {
  readonly direction: 'bidi' | 'uni' | null;
  readonly early?: boolean;
  readonly writer: NativeQuicWriter;
  readonly closed: Promise<void>;
  onerror?: (error: unknown) => void;
  onreset?: (error: unknown) => void;
  onstopsending?: (error: unknown) => void;
  resetStream(code?: bigint | number): void;
  stopSending(code?: bigint | number): void;
}

export interface NativeQuicCloseOptions {
  readonly code?: bigint | number;
  readonly type?: 'transport' | 'application';
  readonly reason?: string;
}

export interface NativeQuicSession {
  readonly opened: Promise<NativeQuicOpenedInfo>;
  readonly closed: Promise<void>;
  readonly maxDatagramSize: number;
  createBidirectionalStream(): Promise<NativeQuicStream>;
  createUnidirectionalStream(): Promise<NativeQuicStream>;
  sendDatagram(data: Uint8Array): Promise<bigint>;
  close(options?: NativeQuicCloseOptions): Promise<void>;
  destroy(error?: unknown, options?: NativeQuicCloseOptions): void;
}

export interface NativeQuicConnectOptions {
  readonly endpoint?: { readonly address: string };
  readonly reuseEndpoint?: boolean;
  readonly alpn: string;
  readonly servername: string;
  readonly enableEarlyData: boolean;
  readonly verifyPeer: 'strict' | 'auto' | 'manual';
  readonly rejectUnauthorized: boolean;
  readonly ca?: ArrayBuffer | ArrayBufferView | readonly (ArrayBuffer | ArrayBufferView)[];
  readonly handshakeTimeout?: number;
  readonly transportParams: {
    readonly maxDatagramFrameSize: number;
  };
  readonly onstream: (stream: NativeQuicStream) => void;
  readonly ondatagram: (datagram: Uint8Array, early: boolean) => void;
  readonly onerror: (error: unknown) => void;
}

export interface NativeQuicRuntime {
  connect(address: string, options: NativeQuicConnectOptions): Promise<NativeQuicSession>;
}
