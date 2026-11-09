import type { CommandDispatcher, ConfiguredDecoder } from './command-dispatcher.js';

/** Exact successful dispatch, including any application command transformation. */
export interface InstalledDecoderConfiguration {
  readonly dispatcher: CommandDispatcher;
  readonly requested: Uint8Array;
  readonly configured: Uint8Array;
  readonly format: ConfiguredDecoder;
}

/** Mutation ledger owned by the existing media preparation, not another operation. */
export interface PreparedDecoderConfiguration {
  readonly owner: object;
  readonly previous: InstalledDecoderConfiguration;
  readonly requested: Uint8Array;
  applied: boolean;
}
