const readline = require('readline');

let _rl = null;

function _getRL() {
  if (!_rl) {
    _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    _rl.on('close', () => { _rl = null; });
  }
  return _rl;
}

/**
 * Em TEST_MODE, pergunta ao operador no terminal e aguarda y/n.
 * Fora do TEST_MODE, resolve true imediatamente.
 * @param {string} message
 * @returns {Promise<boolean>}
 */
function confirmStep(message) {
  const { TEST_MODE } = require('../config');
  if (!TEST_MODE) return Promise.resolve(true);

  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n[TEST] ${message} (y/n): `, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/**
 * Em TEST_MODE, pede uma string ao operador no terminal.
 * @param {string} message
 * @returns {Promise<string>}
 */
function promptValue(message) {
  const { TEST_MODE } = require('../config');
  if (!TEST_MODE) return Promise.resolve('');

  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n[TEST] ${message}: `, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

module.exports = { confirmStep, promptValue };
