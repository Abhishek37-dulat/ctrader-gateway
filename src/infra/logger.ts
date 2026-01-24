import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino";
import type { AppEnv } from "../config/env.js";

export class Logger {
  private constructor(private readonly log: PinoLogger) {}

  static create(env: AppEnv): Logger {
    const opts: LoggerOptions = {
      level: env.logLevel,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
    };
    return new Logger(pino(opts));
  }

  raw(): PinoLogger {
    return this.log;
  }

  info(obj: unknown, msg?: string) {
    this.log.info(obj as any, msg);
  }
  warn(obj: unknown, msg?: string) {
    this.log.warn(obj as any, msg);
  }
  error(obj: unknown, msg?: string) {
    this.log.error(obj as any, msg);
  }
  debug(obj: unknown, msg?: string) {
    this.log.debug(obj as any, msg);
  }
  fatal(obj: unknown, msg?: string) {
    this.log.fatal(obj as any, msg);
  }
}
