/**
 * Service-layer error carrying an HTTP status. Lives in its own leaf module
 * so auth.ts (and anything else admin.ts depends on) can throw it without
 * an import cycle; admin.ts re-exports it for existing importers.
 */

export class ServiceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
