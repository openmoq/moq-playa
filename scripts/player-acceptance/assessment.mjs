export function assessPlayback(samples, expected = { videoWidth: 640, videoHeight: 360, audioHz: 440, videoFps: 24 }) {
  const failures = new Set();
  const first = samples[0];
  const last = samples.at(-1);
  const durationMs = first && last ? last.wallMs - first.wallMs : 0;
  if (samples.length < 16 || durationMs < 5000) failures.add('insufficient-observations');
  const numericFields = ['wallMs', 'mediaTimeS', 'presentedMediaTimeS', 'presentedFrames', 'pictureChange', 'audioRms', 'audioPeakHz', 'videoWidth', 'videoHeight'];
  if (samples.some((s) => numericFields.some((field) => !Number.isFinite(s[field])))) {
    failures.add('invalid-observation');
  }
  const outputKind = expected.outputKind ?? 'video';
  if (samples.some((s) => s.outputKind !== outputKind)) failures.add('output-kind');
  if (outputKind === 'canvas') {
    const domain = expected.timestampDomain;
    if (!['wall-clock', 'media'].includes(domain) || !Number.isFinite(expected.publisherEpochMs)
      || samples.some((s) => !Number.isFinite(s.frameTimestampUs) || !Number.isFinite(s.wallEpochMs)
        || s.frameTimestampUs < 0
        || Math.abs(s.frameTimestampUs / 1000 - (domain === 'media' ? s.wallEpochMs - expected.publisherEpochMs : s.wallEpochMs)) > 2000)) {
      failures.add('timestamp-domain');
    }
    if (first && samples.some((s) => Math.abs((s.frameTimestampUs - first.frameTimestampUs) / 1_000_000
      - (s.presentedMediaTimeS - first.presentedMediaTimeS)) > 0.001)) failures.add('presentation-clock');
  }
  if (samples.some((s) => s.outputKind === 'canvas' ? s.bufferedRanges !== null
    : !Array.isArray(s.bufferedRanges) || s.bufferedRanges.some((r) => !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end <= r.start))) {
    failures.add('invalid-observation');
  }
  if (samples.some((s) => s.paused || s.seeking || s.visibility !== 'visible')) {
    failures.add('playback-inactive');
  }
  if (samples.some((s) => s.videoWidth !== expected.videoWidth || s.videoHeight !== expected.videoHeight
    || s.markerRgb?.length !== 3 || !s.markerRgb.every(Number.isFinite)
    || !(s.markerRgb[0] < 60 && s.markerRgb[1] > 180 && s.markerRgb[2] < 60))) failures.add('video-identity');
  if (samples.some((s) => s.outputKind === 'video' && Array.isArray(s.bufferedRanges)
    && !s.bufferedRanges.some((r) => r.start <= s.mediaTimeS && s.mediaTimeS < r.end))) {
    failures.add('buffer-gap');
  }
  let pictureSince = first?.wallMs ?? 0;
  let presentationSince = first?.wallMs ?? 0;
  let playheadSince = first?.wallMs ?? 0;
  let audioSince = first?.wallMs ?? 0;
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1];
    const sample = samples[i];
    const intervalMs = sample.wallMs - previous.wallMs;
    if (intervalMs <= 0 || intervalMs > 1000) failures.add('observation-gap');
    if (sample.pictureDigest !== previous.pictureDigest && sample.pictureChange > 1) pictureSince = sample.wallMs;
    if (sample.presentedFrames > previous.presentedFrames
      && sample.presentedMediaTimeS > previous.presentedMediaTimeS) presentationSince = sample.wallMs;
    if (sample.mediaTimeS > previous.mediaTimeS + 0.001) playheadSince = sample.wallMs;
    if (sample.wallMs - pictureSince >= 1500) failures.add('picture-frozen');
    if (sample.wallMs - presentationSince >= 1500) failures.add('presentation-stalled');
    if (sample.wallMs - playheadSince >= 1500) failures.add('playhead-stalled');
    if (sample.audioRms > 0.015) audioSince = sample.wallMs;
    else if (sample.wallMs - audioSince >= 500) failures.add('audio-missing');
    const start = samples.find((s) => s.wallMs >= sample.wallMs - 1000);
    if (start && sample.wallMs - start.wallMs >= 750
      && (sample.presentedFrames - start.presentedFrames) / ((sample.wallMs - start.wallMs) / 1000) < expected.videoFps * 0.5) {
      failures.add('presentation-rate');
    }
  }
  if (first && last && last.mediaTimeS - first.mediaTimeS < durationMs / 1000 * 0.8) {
    failures.add('playhead-stalled');
  }
  if (first && last && (last.presentedMediaTimeS - first.presentedMediaTimeS < durationMs / 1000 * 0.8
    || last.presentedMediaTimeS - first.presentedMediaTimeS > durationMs / 1000 * 1.2)) failures.add('presentation-clock');
  if (first && last && (last.presentedFrames - first.presentedFrames) / (durationMs / 1000) < expected.videoFps * 0.8) {
    failures.add('presentation-rate');
  }
  const audible = samples.filter((s) => s.audioRms > 0.015);
  if (audible.length < samples.length * 0.8) failures.add('audio-missing');
  if (audible.length > 0 && audible.filter((s) => Math.abs(s.audioPeakHz - expected.audioHz) <= 35).length < audible.length * 0.8) {
    failures.add('audio-identity');
  }
  return { passed: failures.size === 0, failures: [...failures], samples: samples.length, durationMs };
}
