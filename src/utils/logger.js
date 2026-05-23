// S18 — Logging estruturado: timestamp + nível em todos os logs, filtro por LOG_LEVEL.
// Mecanismo: wrapper global de console (um único ponto), preservando os prefixos
// de módulo já presentes nas mensagens ([WA], [EU], [DB], [DISPATCH], [HEALTH], [AUTH]).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Ruído interno do libsignal/Baileys (decrypt de msgs antigas) — sempre suprimido.
const NOISE = ['Session error:', 'Failed to decrypt', 'Closing open session', 'Closing session:'];

function passes(level, threshold) {
  return (LEVELS[level] ?? LEVELS.info) >= threshold;
}

function isNoise(args) {
  const first = String(args[0] ?? '');
  return NOISE.some((p) => first.includes(p));
}

function buildLine(level, args) {
  return [`${new Date().toISOString()} [${level.toUpperCase()}]`, ...args];
}

// Instala wrappers no console global. Idempotente o suficiente para 1 chamada no boot.
function installConsole(levelName = 'info') {
  const threshold = LEVELS[levelName] ?? LEVELS.info;
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: (console.debug || console.log).bind(console),
  };

  function emit(level, sink, args) {
    if (!passes(level, threshold)) return;
    if (level === 'error' && isNoise(args)) return;
    sink(...buildLine(level, args));
  }

  console.debug = (...a) => emit('debug', orig.debug, a);
  console.log = (...a) => emit('info', orig.log, a);
  console.info = (...a) => emit('info', orig.info, a);
  console.warn = (...a) => emit('warn', orig.warn, a);
  console.error = (...a) => emit('error', orig.error, a);
}

// Logger com prefixo de módulo, p/ código novo: const log = createLogger('DISPATCH').
function createLogger(mod) {
  const tag = `[${mod}]`;
  return {
    debug: (...a) => console.debug(tag, ...a),
    info: (...a) => console.log(tag, ...a),
    warn: (...a) => console.warn(tag, ...a),
    error: (...a) => console.error(tag, ...a),
  };
}

module.exports = { LEVELS, installConsole, createLogger, passes, isNoise, buildLine };
