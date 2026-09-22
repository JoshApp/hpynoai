/** Minimal engine logger — no app coupling. Warnings/errors only in production. */
const DEV = import.meta.env.DEV;

export const elog = {
  info: (scope: string, msg: string, ...rest: unknown[]): void => {
    if (DEV) console.warn(`[${scope}] ${msg}`, ...rest);
  },
  warn: (scope: string, msg: string, ...rest: unknown[]): void => {
    console.warn(`[${scope}] ${msg}`, ...rest);
  },
  error: (scope: string, msg: string, ...rest: unknown[]): void => {
    console.error(`[${scope}] ${msg}`, ...rest);
  },
};
