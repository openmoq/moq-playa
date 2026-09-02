/**
 * `@fails-components/webtransport` ships no type declarations for the entry we
 * use, so the surface we actually touch is declared here rather than weakening
 * the compiler for the whole project.
 */
declare module "@fails-components/webtransport" {
  export const quicheLoaded: Promise<void> | undefined;
  export class WebTransport {
    constructor(url: string, options?: Record<string, unknown>);
    readonly ready: Promise<void>;
    readonly closed: Promise<unknown>;
    readonly protocol?: string;
    close(info?: { closeCode?: number; reason?: string }): void;
  }
}
