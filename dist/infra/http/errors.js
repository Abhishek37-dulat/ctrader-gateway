// src/infra/http/errors.ts
export class HttpError extends Error {
    constructor(status, message, details, cause) {
        super(message);
        this.status = status;
        this.details = details;
        this.cause = cause;
        this.name = "HttpError";
    }
}
export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg, details) => new HttpError(401, msg, details);
export const notFound = (msg, details) => new HttpError(404, msg, details);
export function isHttpError(err) {
    return err instanceof HttpError;
}
/**
 * Normalize any thrown value into an HttpError.
 * Handles:
 * - HttpError
 * - plain objects: { statusCode/status, message, details, validation }
 * - Fastify validation/parsing errors (often have statusCode/message)
 * - JSON parse errors (SyntaxError)
 */
export function toHttpError(err) {
    if (err instanceof HttpError)
        return err;
    // JSON parse errors typically show up as SyntaxError
    if (err instanceof SyntaxError) {
        return new HttpError(400, "INVALID_JSON", { message: err.message }, err);
    }
    // Many libs/frameworks throw plain objects or errors with statusCode
    const anyErr = err;
    if (anyErr && typeof anyErr === "object") {
        const statusRaw = anyErr.statusCode ?? anyErr.status;
        const status = Number(statusRaw);
        // Prefer explicit message if present, but don't leak weird non-strings
        const msg = typeof anyErr.message === "string" && anyErr.message.trim()
            ? anyErr.message
            : undefined;
        const details = anyErr.details ?? anyErr.validation ?? undefined;
        if (Number.isFinite(status) && status >= 400 && status <= 599) {
            return new HttpError(status, msg ?? "REQUEST_ERROR", details, err);
        }
    }
    // Default: internal
    return new HttpError(500, "INTERNAL_ERROR", undefined, err);
}
