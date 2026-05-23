// Smoke: GRUPO 8 logger (S18) — filtro de nível, timestamp, supressão de ruído.
const logger = require('../src/utils/logger');
const { LEVELS, passes, isNoise, buildLine } = logger;

// Writer cru (bypassa console — installConsole abaixo reescreve console.*).
const rawOut = process.stdout.write.bind(process.stdout);
let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; rawOut(`  PASS ${n}\n`); } else { fail++; rawOut(`  FAIL ${n}\n`); } };

// passes(): filtro por threshold
check('passes: info >= info', passes('info', LEVELS.info) === true);
check('passes: debug < info (filtra)', passes('debug', LEVELS.info) === false);
check('passes: error >= warn', passes('error', LEVELS.warn) === true);
check('passes: warn < error (filtra)', passes('warn', LEVELS.error) === false);

// isNoise(): ruído Baileys
check('isNoise: "Session error:" detectado', isNoise(['Session error: x']) === true);
check('isNoise: log normal não é ruído', isNoise(['[WA] conectado']) === false);

// buildLine(): timestamp ISO + tag de nível + args preservados
const line = buildLine('warn', ['[DISPATCH]', 'oi']);
check('buildLine: tag de nível', line[0].includes('[WARN]'));
check('buildLine: timestamp ISO', /^\d{4}-\d{2}-\d{2}T/.test(line[0]));
check('buildLine: preserva args', line[1] === '[DISPATCH]' && line[2] === 'oi');

// installConsole('warn'): info suprimido, warn emitido c/ timestamp+nível.
// Captura stdout (log/info) e stderr (warn/error).
const out = [];
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);
logger.installConsole('warn');
process.stdout.write = (c, ...r) => { out.push(String(c)); return origOut(c, ...r); };
process.stderr.write = (c, ...r) => { out.push(String(c)); return origErr(c, ...r); };
console.log('[X] info-deve-sumir');
console.warn('[X] warn-deve-aparecer');
console.error('Session error: ruido-deve-sumir');
process.stdout.write = origOut;
process.stderr.write = origErr;

check('installConsole: info suprimido (LOG_LEVEL=warn)', !out.some(l => l.includes('info-deve-sumir')));
check('installConsole: warn aparece c/ [WARN]+ts', out.some(l => l.includes('warn-deve-aparecer') && l.includes('[WARN]') && /\d{4}-\d{2}-\d{2}T/.test(l)));
check('installConsole: ruído Baileys suprimido', !out.some(l => l.includes('ruido-deve-sumir')));

rawOut(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
