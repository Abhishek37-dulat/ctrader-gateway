export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new HttpError(400, msg, details);

export const unauthorized = (msg: string, details?: unknown) =>
  new HttpError(401, msg, details);

export const notFound = (msg: string, details?: unknown) =>
  new HttpError(404, msg, details);
