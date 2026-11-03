export interface AudioSwitchVariant {
  kind: 'metadata-only' | 'header-timing-rewrite';
  sameDeclaredAltGroup: number | null;
  originalSets: number[];
  metadataOnly: boolean;
  mediaBytesUnchanged: boolean;
  encodedPayloadUnchanged: boolean;
  fileHashes: Record<string, { beforeSha256: string; afterSha256: string }>;
  encodedPayloadProof: Record<string, { beforeSha256: string; afterSha256: string; bytes: number }>;
  timingRewrite: { field: 'tfdt'; track: string; offsetUs: string; offsetTicks: string } | null;
  audioSamples: number;
  referenceMap: { sourceTimeUs: string; referenceTimeUs: string };
  timingEvidence: string;
}
export function prepareAudioSwitchVariant(source: string, destination: string,
  provenance: Readonly<Record<string, unknown>>, sameSet: boolean): Promise<Record<string, unknown> & {
    sha256: Record<string, string>; audioSelectionVariant: AudioSwitchVariant;
  }>;
