import pino from "pino";
export class Logger {
    constructor(log) {
        this.log = log;
    }
    static create(env) {
        const opts = {
            level: env.logLevel,
            base: null,
            timestamp: pino.stdTimeFunctions.isoTime,
        };
        return new Logger(pino(opts));
    }
    raw() {
        return this.log;
    }
    info(obj, msg) {
        this.log.info(obj, msg);
    }
    warn(obj, msg) {
        this.log.warn(obj, msg);
    }
    error(obj, msg) {
        this.log.error(obj, msg);
    }
    debug(obj, msg) {
        this.log.debug(obj, msg);
    }
    fatal(obj, msg) {
        this.log.fatal(obj, msg);
    }
}
