export function assessPlayback(samples) {
  const failures = new Set();
  const first = samples[0];
  const last = samples.at(-1);
  const durationMs = first && last ? last.wallMs - first.wallMs : 0;
  if (samples.length < 16 || durationMs < 5000) failures.add('insufficient-observations');
  const numericFields = ['wallMs', 'mediaTimeS', 'presentedMediaTimeS', 'presentedFrames', 'pictureChange', 'audioRms', 'audioPeakHz'];
  if (samples.some((s) => numericFields.some((field) => !Number.isFinite(s[field])))) {
    failures.add('invalid-observation');
  }
  if (samples.some((s) => s.paused || s.seeking || s.visibility !== 'visible')) {
    failures.add('playback-inactive');
  }
  if (samples.some((s) => !s.markerMatches)) failures.add('video-identity');
  if (samples.some((s) => !s.bufferedRanges.some((r) => r.start <= s.mediaTimeS && s.mediaTimeS < r.end))) {
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
      && (sample.presentedFrames - start.presentedFrames) / ((sample.wallMs - start.wallMs) / 1000) < 12) {
      failures.add('presentation-rate');
    }
  }
  if (first && last && last.mediaTimeS - first.mediaTimeS < durationMs / 1000 * 0.8) {
    failures.add('playhead-stalled');
  }
  if (first && last && (last.presentedFrames - first.presentedFrames) / (durationMs / 1000) < 24 * 0.8) {
    failures.add('presentation-rate');
  }
  const audible = samples.filter((s) => s.audioRms > 0.015);
  if (audible.length < samples.length * 0.8) failures.add('audio-missing');
  if (audible.length > 0 && audible.filter((s) => Math.abs(s.audioPeakHz - 440) <= 35).length < audible.length * 0.8) {
    failures.add('audio-identity');
  }
  return { passed: failures.size === 0, failures: [...failures], samples: samples.length, durationMs };
}
