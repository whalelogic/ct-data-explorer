/** An error whose message is safe to show to the user. */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} message user-facing message naming the problem
   * @param {unknown} [details] machine-readable context, e.g. a list of validation problems
   */
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}
