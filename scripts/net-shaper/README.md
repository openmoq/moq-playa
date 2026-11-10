# Shaper tests

`pnpm test:ci` runs the standard project and then the serialized
`native-correctness` project. Standard tests cover controlled-clock serialization,
queue bounds, deterministic loss/jitter, CLI validation, mocked startup cleanup,
and schedule-oracle/artifact helpers. Native correctness checks real loopback
bind-refusal ownership, echo, and idempotent close; it runs with one worker.

```sh
pnpm test --project standard
pnpm test --project native-correctness --maxWorkers=1 --no-file-parallelism --retry=0
pnpm test:shaper:performance
```

The explicit performance lane contains nine real-UDP cases, runs with one worker
and no parallel files, and retries zero times. It retains the strict p99 <2ms
send-lateness criterion:1500ms offered36Mbps, shaped30Mbps, queue64MiB.

Two separately named schedule cases preserve their assertions: serializer
virtual-finish timing (<15ms), and release/receive endpoint timing (each endpoint
and drift <15ms). Neither substitutes for the other. Endpoint diagnostics are
written after measurement to `MOQ_SHAPER_ARTIFACT_DIR`, or a temporary directory.

```sh
pnpm test:shaper:performance -t 'adds under 2 ms p99'
pnpm exec vitest list --project standard --filesOnly
pnpm exec vitest list --project native-correctness
pnpm exec vitest list --config vitest.shaper-performance.config.ts
```

Record host, OS, Node version, concurrent load, commands, and all outcomes.
Monotonic serializer deadlines describe intended timing; they cannot prevent OS
descheduling. Userspace dispatch is not kernel transmission or client arrival.
The endpoint case measures distinct callbacks on local loopback; none of these
checks proves remote-network performance or physical speaker output.
