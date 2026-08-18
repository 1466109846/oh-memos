export type FireAndForgetInitializer = () => Promise<void> | void;
export type FireAndForgetErrorHandler = (error: unknown) => void;

/**
 * Return a process-local trigger for an asynchronous initializer.
 *
 * The guard is set before invoking the initializer, so synchronous throws and
 * rejected promises cannot cause a later tool call to start a second attempt.
 */
export function createOnceFireAndForget(
  initializer: FireAndForgetInitializer,
  onError: FireAndForgetErrorHandler,
): () => boolean {
  let started = false;

  return (): boolean => {
    if (started) return false;
    started = true;

    const report = (error: unknown): void => {
      try {
        onError(error);
      } catch {
        // Error reporting must never create an unhandled rejection.
      }
    };

    try {
      void Promise.resolve(initializer()).catch(report);
    } catch (error) {
      report(error);
    }
    return true;
  };
}
