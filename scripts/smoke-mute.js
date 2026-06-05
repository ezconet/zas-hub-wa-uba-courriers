// Smoke: watchdog de "grupo mudo" (muteWatch) — sem WhatsApp real.
process.env.WA_GROUP_JID = 'grp@g.us';
process.env.WA_PROBE_GROUP_JID = 'probe@g.us';
process.env.ZASHUB_WEBHOOK_URL = 'http://localhost:9/api';
process.env.ZASHUB_WEBHOOK_SECRET = 'x';
process.env.API_SECRET = 'x';
process.env.MUTE_UNDECRYPTED_THRESHOLD = '2';
process.env.MUTE_PROBE_WAIT1_MS = '80';
process.env.MUTE_PROBE_WAIT2_MS = '80';

const waClient = require('../src/wa/client');
const probes = [];
let repaired = 0;
waClient.sendText = async (jid) => { probes.push(jid); return { key: { id: 'x' } }; };
waClient.reconnect = () => { repaired += 1; };

const mute = require('../src/services/muteWatch');

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const grpStub = () => ({ messages: [{ key: { remoteJid: 'grp@g.us', participant: 'p@lid' }, messageStubType: 2 }] });
const grpOk = () => ({ messages: [{ key: { remoteJid: 'grp@g.us' }, message: { conversation: 'eu' } }] });
const probeOk = () => ({ messages: [{ key: { remoteJid: 'probe@g.us' }, message: { conversation: 'hc' } }] });

async function main() {
  // T1: stub, ok (reset), stub → só 1 consecutivo → NÃO dispara
  mute.observeUpsert(grpStub());
  mute.observeUpsert(grpOk());
  mute.observeUpsert(grpStub());
  await sleep(30);
  check('T1: stub isolado (reset por leitura) não dispara probe', probes.length === 0 && repaired === 0);

  // T2: 2 stubs → confirma → probe; leitura no probe durante janela → saudável (sem repair)
  mute.observeUpsert(grpOk()); // reset
  mute.observeUpsert(grpStub());
  mute.observeUpsert(grpStub()); // atinge threshold → startConfirm → probe1
  mute.observeUpsert(probeOk()); // leu do probe → readSeen
  await sleep(160);
  check('T2: probe enviado ao detectar mudo', probes.length >= 1 && probes[0] === 'probe@g.us');
  check('T2: leitura no probe → NÃO repara', repaired === 0);

  // T3: 2 stubs → confirma → nenhuma leitura → 2 probes → repair
  probes.length = 0;
  mute.observeUpsert(grpOk()); // reset
  mute.observeUpsert(grpStub());
  mute.observeUpsert(grpStub()); // threshold → confirm
  await sleep(300); // WAIT1(80) + WAIT2(80) + folga
  check('T3: 2 probes enviados sem leitura', probes.length >= 2);
  check('T3: grupo mudo confirmado → reconnect chamado', repaired === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERRO:', e); process.exit(1); });
