/** Invalidates asynchronous UI writes when the user changes ledger or account. */
export class ViewContext {
  private generation = 0;

  invalidate(): void {
    this.generation += 1;
  }

  capture(): () => boolean {
    const generation = this.generation;
    return () => generation === this.generation;
  }
}
