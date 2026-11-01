// The adapter's MEDIA-ELEMENT metrics: sampled from a <video> element (rVFC frames/media time/age, paused, seeking,
// buffered-ahead, playhead) or from the document that hosts it (visibility). A canvas-only arm must report NONE of
// them. Membership is an explicit list, never a name prefix: engine counters such as `video_decode_submissions`
// share the `video_` prefix and are expected on a canvas arm.
export const ELEMENT_METRICS = Object.freeze(['video_presented_frames', 'video_frame_media_time', 'video_frame_age',
  'video_paused', 'video_seeking', 'video_buffer_ahead', 'video_playhead', 'document_hidden']);

/** The element metrics present among `names` (an iterable of metric names), in list order. */
export function reportedElementMetrics(names) {
  const set = names instanceof Set ? names : new Set(names);
  return ELEMENT_METRICS.filter(n => set.has(n));
}
