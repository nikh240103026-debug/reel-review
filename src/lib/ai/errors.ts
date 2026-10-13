export class AiError extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
