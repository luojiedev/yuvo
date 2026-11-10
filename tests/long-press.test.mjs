import assert from "node:assert/strict";
import test from "node:test";
import { createLongPressController } from "../lib/long-press.ts";

function createFixture() {
  const events = [];
  let scheduled = null;
  const controller = createLongPressController({
    onShortPress: () => events.push("short"),
    onLongPress: () => events.push("long"),
    scheduler: {
      schedule(callback) {
        scheduled = callback;
        return callback;
      },
      cancel(handle) {
        if (scheduled === handle) scheduled = null;
      },
    },
  });
  return {
    controller,
    events,
    elapseLongPress: () => {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    },
  };
}

test("a short press triggers only the primary operator", () => {
  const fixture = createFixture();
  fixture.controller.start();
  fixture.controller.finish();
  assert.deepEqual(fixture.events, ["short"]);
});

test("a long press triggers only the alternate operator", () => {
  const fixture = createFixture();
  fixture.controller.start();
  fixture.elapseLongPress();
  fixture.controller.finish();
  assert.deepEqual(fixture.events, ["long"]);
});

test("cancelling a press triggers neither operator", () => {
  const fixture = createFixture();
  fixture.controller.start();
  fixture.controller.cancel();
  fixture.controller.finish();
  assert.deepEqual(fixture.events, []);
});
