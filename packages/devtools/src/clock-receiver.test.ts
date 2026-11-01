import { expect, it } from 'vitest';
import { DiagnosticCapture } from './capture.js';
import { decodeMessage } from '@openmoq/devtools-protocol';
import { fixtureSource } from '@openmoq/devtools-protocol/fixtures';

it('preserves a supplied clock method receiver without sampling during construction', () => {
  let reads = 0;
  const clock = { id: 'instance-clock', time: 7, now() { reads++; return this.time; } };
  const capture = new DiagnosticCapture({source:fixtureSource,clock});
  expect(reads).toBe(0);
  const {lease}=capture.attach('owner','attach');
  try {
    capture.emit({kind:'control',sessionId:'session',requestId:null,streamId:null,messageType:'SETUP',direction:'sent'},'dense');
    const result=decodeMessage(lease.pull());
    expect(result).toMatchObject({ok:true,message:{kind:'batch',events:[{timeMs:7}]}});
    clock.time=8;
    capture.emit({kind:'control',sessionId:'session',requestId:null,streamId:null,messageType:'SETUP',direction:'received'},'dense');
    expect(decodeMessage(lease.pull())).toMatchObject({ok:true,message:{kind:'batch',events:[{timeMs:8}]}});
  } finally {lease.close();capture.dispose();}
});
