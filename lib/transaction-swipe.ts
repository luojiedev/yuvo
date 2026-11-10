export type TransactionSwipeAxis = "pending" | "horizontal" | "vertical";

export interface TransactionSwipeState {
  id: string;
  startX: number;
  startY: number;
  initialOffset: number;
  axis: TransactionSwipeAxis;
}

export interface TransactionSwipeMovement {
  state: TransactionSwipeState;
  offset: number;
  isHorizontal: boolean;
}

const ACTION_WIDTH = 144;
const DIRECTION_LOCK_DISTANCE = 10;
const HORIZONTAL_DOMINANCE = 1.25;

export function beginTransactionSwipe(
  id: string,
  x: number,
  y: number,
  isOpen: boolean,
): TransactionSwipeState {
  return {
    id,
    startX: x,
    startY: y,
    initialOffset: isOpen ? -ACTION_WIDTH : 0,
    axis: "pending",
  };
}

export function moveTransactionSwipe(
  state: TransactionSwipeState,
  x: number,
  y: number,
): TransactionSwipeMovement {
  const deltaX = x - state.startX;
  const deltaY = y - state.startY;
  let axis = state.axis;

  if (axis === "pending" && Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= DIRECTION_LOCK_DISTANCE) {
    const isClearlyHorizontal = Math.abs(deltaX) >= Math.abs(deltaY) * HORIZONTAL_DOMINANCE;
    const canMoveHorizontally = deltaX < 0 || state.initialOffset < 0;
    axis = isClearlyHorizontal && canMoveHorizontally ? "horizontal" : "vertical";
  }

  const nextState = axis === state.axis ? state : { ...state, axis };
  if (axis !== "horizontal") {
    return { state: nextState, offset: state.initialOffset, isHorizontal: false };
  }

  return {
    state: nextState,
    offset: Math.max(-ACTION_WIDTH, Math.min(0, state.initialOffset + deltaX)),
    isHorizontal: true,
  };
}

export function shouldOpenTransactionActions(
  state: TransactionSwipeState,
  x: number,
): boolean {
  if (state.axis !== "horizontal") return state.initialOffset < 0;
  return state.initialOffset + x - state.startX < -54;
}
