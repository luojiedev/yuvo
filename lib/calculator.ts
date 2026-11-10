export type MathOperator = "+" | "−" | "×" | "÷";

export interface CalculatorState {
  display: string;
  accumulatorMinor: number | null;
  operator: MathOperator | null;
  operandInput: string;
  awaitingOperand: boolean;
}

export const initialCalculatorState: CalculatorState = {
  display: "0",
  accumulatorMinor: null,
  operator: null,
  operandInput: "",
  awaitingOperand: false,
};

export function toMinorAmount(value: string): number {
  const normalized = value.trim();
  if (!/^-?\d+(\.\d{0,2})?$/.test(normalized)) {
    throw new Error("请输入有效金额，最多保留两位小数");
  }
  return Math.round(Number(normalized) * 100);
}

export function minorToInput(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

export function calculate(leftMinor: number, rightMinor: number, operator: MathOperator): number {
  if (operator === "+") return leftMinor + rightMinor;
  if (operator === "−") return leftMinor - rightMinor;
  if (operator === "×") return Math.round((leftMinor * rightMinor) / 100);
  if (rightMinor === 0) throw new Error("除数不能为零");
  return Math.round((leftMinor / rightMinor) * 100);
}

function appendDigitToValue(value: string, digit: string): string {
  const [integer, decimal = ""] = value.split(".");
  if (value.includes(".") && decimal.length >= 2) return value;
  if (!value.includes(".") && integer.length >= 9) return value;
  return value === "0" ? digit : `${value}${digit}`;
}

function previewResult(accumulatorMinor: number, operandInput: string, operator: MathOperator): string {
  const operandMinor = toMinorAmount(operandInput);
  if (operator === "÷" && operandMinor === 0) return minorToInput(accumulatorMinor);
  return minorToInput(calculate(accumulatorMinor, operandMinor, operator));
}

export function inputDigit(state: CalculatorState, digit: string): CalculatorState {
  if (!/^\d$/.test(digit)) return state;
  if (state.accumulatorMinor !== null && state.operator) {
    const operandInput = appendDigitToValue(state.awaitingOperand ? "0" : state.operandInput, digit);
    return {
      ...state,
      display: previewResult(state.accumulatorMinor, operandInput, state.operator),
      operandInput,
      awaitingOperand: false,
    };
  }
  return { ...state, display: appendDigitToValue(state.display, digit) };
}

export function inputDecimal(state: CalculatorState): CalculatorState {
  if (state.accumulatorMinor !== null && state.operator) {
    if (!state.awaitingOperand && state.operandInput.includes(".")) return state;
    const operandInput = state.awaitingOperand ? "0." : `${state.operandInput}.`;
    return {
      ...state,
      display: previewResult(state.accumulatorMinor, operandInput, state.operator),
      operandInput,
      awaitingOperand: false,
    };
  }
  return state.display.includes(".") ? state : { ...state, display: `${state.display}.` };
}

export function removeLastDigit(state: CalculatorState): CalculatorState {
  if (state.awaitingOperand) return state;
  if (state.accumulatorMinor !== null && state.operator) {
    const operandInput = state.operandInput.slice(0, -1);
    if (!operandInput) {
      return {
        ...state,
        display: minorToInput(state.accumulatorMinor),
        operandInput: "",
        awaitingOperand: true,
      };
    }
    return {
      ...state,
      display: previewResult(state.accumulatorMinor, operandInput, state.operator),
      operandInput,
    };
  }
  return {
    ...state,
    display: state.display.length <= 1 ? "0" : state.display.slice(0, -1),
  };
}

export function selectOperator(state: CalculatorState, operator: MathOperator): CalculatorState {
  if (state.awaitingOperand) {
    return { ...state, operator };
  }
  const accumulatorMinor = state.accumulatorMinor !== null && state.operator
    ? calculate(state.accumulatorMinor, toMinorAmount(state.operandInput), state.operator)
    : toMinorAmount(state.display);
  return {
    display: minorToInput(accumulatorMinor),
    accumulatorMinor,
    operator,
    operandInput: "",
    awaitingOperand: true,
  };
}

export function resolveCalculator(state: CalculatorState): number {
  if (state.accumulatorMinor !== null && state.operator) {
    if (state.awaitingOperand) return state.accumulatorMinor;
    return calculate(state.accumulatorMinor, toMinorAmount(state.operandInput), state.operator);
  }
  return toMinorAmount(state.display);
}

export function calculatorExpression(state: CalculatorState): string {
  if (state.accumulatorMinor === null || !state.operator) return "";
  return `${minorToInput(state.accumulatorMinor)}${state.operator}${state.operandInput}`;
}
