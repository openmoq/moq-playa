/** Receipt order is transport evidence; processing order and output are judged separately. */
export function assessWarmStart(observed, peer, enabled) {
  const failures = [];
  if (peer.errors.length) failures.push('peer-errors');
  const accepted = peer.events.find(event => event.type === 'accepted' && event.name === 'video-360');
  if (!accepted) return { passed: false, failures: [...failures, 'video-not-accepted'] };
  const fetch = peer.events.find(event => event.type === 'fetch' && event.joining === accepted.request);
  const prefix = observed.received.filter(item => item.source === 'prefix' && item.request === fetch?.request);
  const processed = observed.processed.filter(item => item.alias === accepted.alias);
  if (!processed.length) failures.push('no-processed-video');
  if (!enabled) {
    if (fetch || prefix.length) failures.push('disabled-issued-media-fetch');
    return { passed: failures.length === 0, failures, accepted, processed: processed.length };
  }
  if (accepted.group === null || accepted.object === null || BigInt(accepted.object) < 0n) failures.push('prefix-not-observed');
  if (!fetch || !prefix.length) failures.push('missing-media-prefix');
  const released = peer.events.find(event => event.type === 'prefix-released' && event.request === fetch?.request);
  if (released?.receiverAcknowledged !== 1) failures.push('prefix-not-released-by-receiver');
  const live = observed.received.find(item => item.source === 'live' && item.alias === accepted.alias);
  if (!live || !prefix.length || live.seq >= prefix[0].seq) failures.push('live-did-not-overtake-prefix');
  const last = BigInt(accepted.object ?? -1);
  const prefixProcessed = processed.filter(item => item.group === accepted.group && BigInt(item.object) <= last);
  if (BigInt(prefixProcessed.length) !== last + 1n || prefixProcessed.some((item, index) => BigInt(item.object) !== BigInt(index))) failures.push('prefix-processing-not-contiguous');
  if (processed[0]?.group !== accepted.group || processed[0]?.object !== '0') failures.push('processing-started-with-tail');
  const keys = processed.map(item => JSON.stringify([item.group, item.object]));
  if (new Set(keys).size !== keys.length) failures.push('duplicate-video-processing');
  const tail = processed.find(item => BigInt(item.group) > BigInt(accepted.group ?? 0)
    || item.group === accepted.group && BigInt(item.object) > last);
  if (!tail || prefixProcessed.some(item => item.seq >= tail.seq)) failures.push('tail-did-not-follow-prefix');
  return { passed: failures.length === 0, failures, accepted, fetch,
    rawFirstLive: live ?? null, rawFirstPrefix: prefix[0] ?? null,
    prefixProcessed: prefixProcessed.length, processed: processed.length };
}
