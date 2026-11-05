export interface ProgramFixtureTrack {
  name: string;
  role: 'video' | 'audio';
  renderGroup: number;
  altGroup: number;
  sourceTrack: string;
  offsetUs: string;
  firstPresentationTimeUs: string;
  firstLocTimeUs: string;
  timescale: number;
  samples: number;
  compositionOffsetsTicks: number[];
  durationTicks: number[];
}
export interface ProgramSwitchVariant {
  kind: 'header-timing-rewrite';
  metadataOnly: false;
  mediaBytesUnchanged: false;
  encodedPayloadUnchanged: true;
  tracks: Record<'oldVideo' | 'viewVideo' | 'nextVideo' | 'oldAudio' | 'nextAudio', ProgramFixtureTrack>;
  maps: {
    program: { video: { sourceTimeUs: string; referenceTimeUs: string }; audio: { sourceTimeUs: string; referenceTimeUs: string } };
    view: { video: { sourceTimeUs: string; referenceTimeUs: string } };
  };
  fileHashes: Record<string, { source: string; beforeSha256: string; afterSha256: string }>;
  encodedPayloadProof: Record<string, { beforeSha256: string; afterSha256: string; bytes: number }>;
  timingEvidence: string;
}
export function prepareProgramSwitchVariant(source: string, destination: string,
  provenance: Readonly<Record<string, unknown>>): Promise<Record<string, unknown> & {
    sha256: Record<string, string>; programSelectionVariant: ProgramSwitchVariant;
  }>;
