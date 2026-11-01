import test from 'node:test';
import assert from 'node:assert/strict';
import { ELEMENT_METRICS, reportedElementMetrics } from './element-metrics.mjs';

test('engine counters that share the video_ prefix are NOT element metrics', () => {
  const canvasArm = new Set(['receive_bitrate', 'objects_received', 'frames_rendered', 'video_decode_submissions', 'frames_decoded', 'audio_outputs_decoded', 'diagnostic_evidence_loss']);
  assert.deepEqual(reportedElementMetrics(canvasArm), []);
});

test('NEGATIVE: any element metric on a canvas arm is named', () => {
  assert.deepEqual(reportedElementMetrics(['frames_rendered', 'video_paused', 'video_decode_submissions']), ['video_paused']);
  assert.deepEqual(reportedElementMetrics(['document_hidden']), ['document_hidden'], 'document visibility is element-derived');
  for (const n of ELEMENT_METRICS) assert.deepEqual(reportedElementMetrics([n]), [n]);
});

test('the list is explicit and frozen', () => {
  assert.ok(Object.isFrozen(ELEMENT_METRICS));
  assert.ok(!ELEMENT_METRICS.includes('video_decode_submissions'));
});
