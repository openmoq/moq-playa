/** Public player entry point; the standalone qlog recorder has no player dependency. */
export {
  TraceRecorder,
  formatLogMessage,
  DEFAULT_TRACE_LIMITS,
  PLAYA_EVENT_SCHEMA,
  LOGLEVEL_EVENT_SCHEMA,
} from '@openmoq/transport/trace-recorder';
export type { TraceLimits, TraceLane, TraceRecorderOptions } from '@openmoq/transport/trace-recorder';
