// Service-layer error carrying an HTTP status.

export class ServiceError extends Error {
  status: number;
  /**
   * Catalog key for the message. When set AND the caller supplied a
   * translator (apiGate's second argument), the message is rendered in the
   * request's language; otherwise the Chinese `message` stands, which is
   * what the admin and member-center surfaces want.
   */
  key?: string;
  params?: Record<string, string | number>;
  constructor(
    message: string,
    status = 400,
    key?: string,
    params?: Record<string, string | number>,
  ) {
    super(message);
    this.status = status;
    this.key = key;
    this.params = params;
  }
}
