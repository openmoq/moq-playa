/**
 * Maps MSF catalog tracks to UI-friendly Level and AudioTrack arrays.
 *
 * @see draft-ietf-moq-msf-00 §5.1 (Track fields)
 * @module
 */

import type { CatalogState } from '@moqt/msf';
import type { Level, AudioTrack } from './types.js';

/**
 * Generate a human-readable resolution label from track metadata.
 */
function resolutionLabel(track: { height?: number; bitrate?: number; name: string }): string {
  if (track.height) {
    const h = track.height;
    if (h >= 2160) return '4K';
    if (h >= 1440) return '1440p';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
    if (h >= 480) return '480p';
    if (h >= 360) return '360p';
    return `${h}p`;
  }
  if (track.bitrate) return `${Math.round(track.bitrate / 1000)}kbps`;
  return track.name;
}

/**
 * Map MSF catalog video tracks to a sorted Level array for UI display.
 *
 * Sorted by bitrate descending (highest quality first, index 0 = best).
 * If the catalog has altGroups, uses the first video altGroup.
 * Otherwise, uses all video tracks.
 *
 * @see draft-ietf-moq-msf-00 §5.1.13 (altGroup)
 */
export function mapLevels(catalog: CatalogState): Level[] {
  const videoTracks = catalog.tracks.filter(
    t => t.codec && (
      t.codec.startsWith('avc1') ||
      t.codec.startsWith('hev1') ||
      t.codec.startsWith('hvc1') ||
      t.codec.startsWith('av01') ||
      t.codec.startsWith('vp09') ||
      t.codec.startsWith('vp8')
    ),
  );

  if (videoTracks.length === 0) return [];

  // Sort by bitrate descending (highest first)
  const sorted = [...videoTracks].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

  return sorted.map((track, index) => ({
    index,
    trackName: track.name,
    label: resolutionLabel(track),
    codec: track.codec ?? 'unknown',
    width: track.width ?? 0,
    height: track.height ?? 0,
    bitrate: track.bitrate ?? 0,
  }));
}

/**
 * Map MSF catalog audio tracks to an AudioTrack array for UI display.
 *
 * @see draft-ietf-moq-msf-00 §5.1.35 (language)
 */
export function mapAudioTracks(catalog: CatalogState): AudioTrack[] {
  const audioTracks = catalog.tracks.filter(
    t => t.codec && (
      t.codec.startsWith('mp4a') ||
      t.codec.startsWith('opus') ||
      t.codec.startsWith('flac') ||
      t.codec === 'ac-3' ||
      t.codec === 'ec-3'
    ),
  );

  return audioTracks.map((track, index) => {
    const lang = (track as unknown as Record<string, unknown>).language as string | undefined;
    return {
      index,
      label: track.label ?? lang ?? `Audio ${index + 1}`,
      language: lang,
      codec: track.codec ?? 'unknown',
    };
  });
}
