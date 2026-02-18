/**
 * Logger simple con niveles y timestamps
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL?.toLowerCase() || 'info'] ?? 1;

const colors = {
  debug: '\x1b[36m', // cyan
  info:  '\x1b[32m', // green
  warn:  '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m',
};

function formatMessage(level, ...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const color = colors[level] || '';
  const reset = colors.reset;
  const prefix = `${color}[${ts}] [${level.toUpperCase()}]${reset}`;
  return [prefix, ...args];
}

export const log = {
  debug: (...args) => {
    if (currentLevel <= LEVELS.debug) console.debug(...formatMessage('debug', ...args));
  },
  info: (...args) => {
    if (currentLevel <= LEVELS.info) console.info(...formatMessage('info', ...args));
  },
  warn: (...args) => {
    if (currentLevel <= LEVELS.warn) console.warn(...formatMessage('warn', ...args));
  },
  error: (...args) => {
    if (currentLevel <= LEVELS.error) console.error(...formatMessage('error', ...args));
  },
};
