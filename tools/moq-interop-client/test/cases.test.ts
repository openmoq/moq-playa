/**
 * Discriminators for the case verdicts: each asserts that a case FAILS when
 * the peer misbehaves, which is the property a passing run cannot show.
 *
 * These drive the REAL case bodies and the REAL response inbox through an
 * injected peer factory, so each assertion is that a case FAILS when the peer
 * misbehaves -- not that it passes when the peer is well behaved. A suite that
 * only shows green runs cannot tell a working verdict from a vacuous one.
 */
import {
  CaseScope, Inbox, __setConnect, __setBoundScale,
  caseSubscribeError, caseAnnounceSubscribe, caseSubscribeBeforeAnnounce,
  casePublishNamespaceDone,
} from "../src/main.js";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`ok - ${name}`);
  else { failures++; console.log(`not ok - ${name}${detail ? ` (${detail})` : ""}`); }
};

const dec = new TextDecoder();
type Scenario = {
  /** what the peer answers a SUBSCRIBE with; "silence" answers nothing */
  subscribeReply?: "SUBSCRIBE_OK" | "REQUEST_ERROR" | "silence";
  /** deliver that reply synchronously inside subscribe(), before it returns */
  replyDuringEmit?: boolean;
  announceReply?: "REQUEST_OK" | "silence";
  /** relay-forwarded SUBSCRIBE to the publisher: when, or never */
  forwardSubscribe?: "before-reply" | "after-reply" | "never";
  withdrawThrows?: boolean;
  secondWithdrawSucceeds?: boolean;
};

function makePeers(sc: Scenario) {
  const peers: any[] = [];
  const connect = async (_d: number, label: string, _s: CaseScope) => {
    const inbox = new Inbox();
    let rid = 0n;
    let withdrawCalls = 0;
    const peer: any = {
      label,
      inbox,
      transport: { closed: Promise.resolve(undefined) },
      conn: {
        onSubscribe: null as any,
        async close() {},
        publishNamespace() {
          const id = rid++;
          if (sc.announceReply !== "silence")
            queueMicrotask(() => inbox.deliver({ type: "REQUEST_OK", requestId: id } as any));
          return id;
        },
        async publishNamespaceDone() {
          withdrawCalls++;
          if (sc.withdrawThrows) throw new Error("induced withdrawal failure");
          if (withdrawCalls > 1 && !sc.secondWithdrawSucceeds) throw new Error("no such namespace");
          return undefined;
        },
        subscribe(_ns: Uint8Array[], _track: Uint8Array, opts: any) {
          const id = rid++;
          opts?.onRequestId?.(id);
          const deliver = () => {
            if (sc.subscribeReply && sc.subscribeReply !== "silence")
              inbox.deliver({ type: sc.subscribeReply, requestId: id, trackAlias: 0n } as any);
          };
          // The publisher-side forward is what `announce-subscribe` waits on.
          const forward = () => {
            const pub = peers.find((p) => p.label === "publisher");
            if (pub?.conn.onSubscribe)
              pub.conn.onSubscribe(99n, [enc("moq-test"), enc("interop")], enc("test-track"));
          };
          if (sc.forwardSubscribe === "before-reply") forward();
          if (sc.replyDuringEmit) deliver(); else queueMicrotask(deliver);
          if (sc.forwardSubscribe === "after-reply") setTimeout(forward, 5);
          return Promise.resolve(undefined);
        },
        async acceptSubscribe() {},
        async rejectSubscribe() {},
      },
    };
    peers.push(peer);
    return peer;
  };
  return connect;
}
const enc = (s: string) => new TextEncoder().encode(s);

async function run(caseFn: (d: number, s: CaseScope) => Promise<void>, sc: Scenario) {
  __setConnect(makePeers(sc) as any);
  const scope = new CaseScope();
  let verdict: Error | null = null;
  try { await caseFn(18, scope); } catch (e) { verdict = e as Error; }
  const fatal = scope.fatal.raised;
  await scope.teardownAll();
  return verdict ?? fatal ?? null;
}

async function main() {
  __setBoundScale(0.02);   // 8000ms bounds become 160ms

  // -- 2. subscribe-error
  check("subscribe-error PASSES on the expected REQUEST_ERROR",
    (await run(caseSubscribeError, { subscribeReply: "REQUEST_ERROR" })) === null);
  {
    const v = await run(caseSubscribeError, { subscribeReply: "silence" });
    check("subscribe-error FAILS on silence", v !== null, v ? "" : "passed on silence");
  }
  {
    const v = await run(caseSubscribeError, { subscribeReply: "SUBSCRIBE_OK" });
    check("subscribe-error FAILS on a forced SUBSCRIBE_OK",
      v !== null && /expected REQUEST_ERROR/.test(v.message), v ? v.message : "passed on SUBSCRIBE_OK");
  }

  // -- 3. announce-subscribe
  check("announce-subscribe PASSES on SUBSCRIBE_OK + forwarded SUBSCRIBE",
    (await run(caseAnnounceSubscribe, { announceReply: "REQUEST_OK", subscribeReply: "SUBSCRIBE_OK", forwardSubscribe: "before-reply" })) === null);
  {
    const v = await run(caseAnnounceSubscribe, { announceReply: "REQUEST_OK", subscribeReply: "REQUEST_ERROR", forwardSubscribe: "before-reply" });
    check("announce-subscribe FAILS on REQUEST_ERROR", v !== null && /expected SUBSCRIBE_OK/.test(v.message), v ? v.message : "passed");
  }
  {
    const v = await run(caseAnnounceSubscribe, { announceReply: "REQUEST_OK", subscribeReply: "silence", forwardSubscribe: "before-reply" });
    check("announce-subscribe FAILS on timeout", v !== null, "passed on silence");
  }
  {
    const v = await run(caseAnnounceSubscribe, { announceReply: "REQUEST_OK", subscribeReply: "SUBSCRIBE_OK", forwardSubscribe: "never" });
    check("announce-subscribe FAILS when the publisher never sees the SUBSCRIBE", v !== null, "passed");
  }
  // ordering: the relay may answer the subscriber BEFORE forwarding upstream
  check("announce-subscribe PASSES when the forward arrives after SUBSCRIBE_OK",
    (await run(caseAnnounceSubscribe, { announceReply: "REQUEST_OK", subscribeReply: "SUBSCRIBE_OK", forwardSubscribe: "after-reply" })) === null);

  // -- 4. subscribe-before-announce: both allowed outcomes pass, silence fails
  check("subscribe-before-announce PASSES on SUBSCRIBE_OK",
    (await run(caseSubscribeBeforeAnnounce, { announceReply: "REQUEST_OK", subscribeReply: "SUBSCRIBE_OK", forwardSubscribe: "never" })) === null);
  check("subscribe-before-announce PASSES on REQUEST_ERROR",
    (await run(caseSubscribeBeforeAnnounce, { announceReply: "REQUEST_OK", subscribeReply: "REQUEST_ERROR", forwardSubscribe: "never" })) === null);
  {
    const v = await run(caseSubscribeBeforeAnnounce, { announceReply: "REQUEST_OK", subscribeReply: "silence", forwardSubscribe: "never" });
    check("subscribe-before-announce FAILS on silence", v !== null, "passed on silence");
  }

  // -- 5. publish-namespace-done
  check("publish-namespace-done PASSES when withdrawal settles and state is reclaimed",
    (await run(casePublishNamespaceDone, { announceReply: "REQUEST_OK" })) === null);
  {
    const v = await run(casePublishNamespaceDone, { announceReply: "REQUEST_OK", withdrawThrows: true });
    check("publish-namespace-done FAILS on an induced withdrawal error",
      v !== null && /induced withdrawal failure/.test(v.message), v ? v.message : "passed");
  }
  {
    const v = await run(casePublishNamespaceDone, { announceReply: "REQUEST_OK", secondWithdrawSucceeds: true });
    check("publish-namespace-done FAILS when local state is not reclaimed",
      v !== null && /did not reclaim/.test(v.message), v ? v.message : "passed");
  }

  // -- 8. synchronous response during request emission is still matched
  check("inbox retains a response delivered synchronously during subscribe()",
    (await run(caseSubscribeError, { subscribeReply: "REQUEST_ERROR", replyDuringEmit: true })) === null);

  console.log(failures === 0 ? "# all case discriminators passed" : `# ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
