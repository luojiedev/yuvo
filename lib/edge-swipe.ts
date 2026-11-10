export interface EdgeSwipeState {
  startX: number;
  startY: number;
  startedAt: number;
}

export function beginEdgeSwipe(x: number, y: number, startedAt: number, edgeWidth = 32): EdgeSwipeState | null {
  return x >= 0 && x <= edgeWidth ? { startX: x, startY: y, startedAt } : null;
}

export function edgeSwipeOffset(state: EdgeSwipeState, x: number, y: number): number {
  const horizontalDistance = x - state.startX;
  const verticalDistance = Math.abs(y - state.startY);
  if (horizontalDistance <= 0 || verticalDistance > Math.max(36, horizontalDistance * 0.8)) return 0;
  return horizontalDistance;
}

export function shouldFinishEdgeSwipe(
  state: EdgeSwipeState,
  x: number,
  y: number,
  finishedAt: number,
): boolean {
  const distance = edgeSwipeOffset(state, x, y);
  const duration = Math.max(1, finishedAt - state.startedAt);
  const velocity = distance / duration;
  return distance >= 88 || (distance >= 46 && velocity >= 0.45);
}
