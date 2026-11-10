export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

export function transactionComplete(transaction: IDBTransaction): Promise<void> {
  const completion = new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("本地写入已取消")), { once: true });
  });
  // Callers may still be awaiting an individual request when the transaction aborts.
  // Attach a handler immediately, but return the original rejecting promise to them.
  void completion.catch(() => undefined);
  return completion;
}
