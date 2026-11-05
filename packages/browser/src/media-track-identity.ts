/** Separate opaque source keys from legacy display names without delimiter assumptions. */
export function mediaTrackIdentity(trackName: string, sourceKey?: string): string {
  return sourceKey === undefined ? `name:${trackName}` : `source:${sourceKey}`;
}
