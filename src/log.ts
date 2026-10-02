export type LogFields = Record<string, unknown>;
export type Logger = {
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
};

// Field names that must never reach the logs, even by mistake.
const REDACT = /pass|token|auth|key|secret|cfg|cookie/i;

const clean = (fields: LogFields | undefined): LogFields => {
  const out: LogFields = {};
  for (const [name, value] of Object.entries(fields ?? {})) {
    out[name] = REDACT.test(name) ? "[redacted]" : value instanceof Error ? value.message : value;
  }
  return out;
};

export const createLogger = (write: (line: string) => void = (line) => console.log(line)): Logger => {
  const emit = (level: string) => (msg: string, fields?: LogFields) =>
    write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...clean(fields) }));
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
