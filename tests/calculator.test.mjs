import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatorExpression,
  initialCalculatorState,
  inputDecimal,
  inputDigit,
  removeLastDigit,
  resolveCalculator,
  selectOperator,
} from "../lib/calculator.ts";

function enter(value) {
  let state = initialCalculatorState;
  for (const character of value) {
    state = character === "." ? inputDecimal(state) : inputDigit(state, character);
  }
  return state;
}

test("selecting plus keeps the current amount visible", () => {
  const entered = enter("9.45");
  const selected = selectOperator(entered, "+");
  assert.equal(selected.display, "9.45");
  assert.equal(selected.accumulatorMinor, 945);
  assert.equal(selected.awaitingOperand, true);
});

test("the first digit after an operator starts the second operand", () => {
  let state = selectOperator(enter("9.45"), "+");
  state = inputDigit(state, "2");
  assert.equal(state.display, "11.45");
  assert.equal(state.operandInput, "2");
  assert.equal(resolveCalculator(state), 1145);
});

test("shows the live result while retaining the entered expression", () => {
  let state = selectOperator(enter("9"), "+");
  state = inputDigit(state, "6");
  assert.equal(state.display, "15");
  assert.equal(calculatorExpression(state), "9+6");
});

test("supports addition, subtraction, multiplication, and division", () => {
  for (const [left, operator, right, expectedMinor] of [
    ["10", "+", "2.5", 1250],
    ["10", "−", "2.5", 750],
    ["10", "×", "2.5", 2500],
    ["10", "÷", "2.5", 400],
  ]) {
    let state = selectOperator(enter(left), operator);
    for (const character of right) {
      state = character === "." ? inputDecimal(state) : inputDigit(state, character);
    }
    assert.equal(state.display, minorToDisplay(expectedMinor));
    assert.equal(resolveCalculator(state), expectedMinor);
  }
});

function minorToDisplay(amountMinor) {
  return (amountMinor / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

test("replaces a pending operator without changing the amount", () => {
  const plus = selectOperator(enter("12"), "+");
  const multiply = selectOperator(plus, "×");
  assert.equal(multiply.display, "12");
  assert.equal(multiply.operator, "×");
  assert.equal(multiply.accumulatorMinor, 1200);
});

test("chains operations using the previous result", () => {
  let state = selectOperator(enter("10"), "+");
  state = inputDigit(state, "5");
  state = selectOperator(state, "×");
  assert.equal(state.display, "15");
  state = inputDigit(state, "2");
  assert.equal(resolveCalculator(state), 3000);
});

test("limits decimals to two digits and supports backspace", () => {
  let state = enter("1.239");
  assert.equal(state.display, "1.23");
  state = removeLastDigit(state);
  assert.equal(state.display, "1.2");
});

test("rejects division by zero", () => {
  let state = selectOperator(enter("10"), "÷");
  state = inputDigit(state, "0");
  assert.throws(() => resolveCalculator(state), /除数不能为零/);
});
