/**
 * Tests for the in-memory OAuth state store.
 *
 * Clock + RNG are injected so TTL + single-use semantics can be exercised
 * without sleeping or relying on real randomness.
 */
import { describe, it, expect } from "vitest";
import { createInMemoryStateStore } from "../adapters/shopify/oauth/state.js";

function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function counterRng(): () => string {
  let i = 0;
  return () => `state-${++i}`;
}

describe("createInMemoryStateStore", () => {
  it("issues a fresh state bound to the shop", () => {
    const clock = makeClock();
    const store = createInMemoryStateStore({
      now: clock.now,
      randomHex: counterRng(),
    });
    const s = store.issue("foo.myshopify.com");
    expect(s).toBe("state-1");
    expect(store.size()).toBe(1);
  });

  it("accepts a valid state once, then rejects on replay", () => {
    const store = createInMemoryStateStore({ randomHex: counterRng() });
    const s = store.issue("foo.myshopify.com");
    expect(store.consume(s, "foo.myshopify.com")).toBe(true);
    expect(store.consume(s, "foo.myshopify.com")).toBe(false);
  });

  it("rejects when the shop on callback differs from the shop on issue", () => {
    const store = createInMemoryStateStore({ randomHex: counterRng() });
    const s = store.issue("foo.myshopify.com");
    expect(store.consume(s, "evil.myshopify.com")).toBe(false);
    // And the state is now burned, so the legitimate shop also gets rejected.
    expect(store.consume(s, "foo.myshopify.com")).toBe(false);
  });

  it("rejects expired states", () => {
    const clock = makeClock();
    const store = createInMemoryStateStore({
      ttlMs: 1000,
      now: clock.now,
      randomHex: counterRng(),
    });
    const s = store.issue("foo.myshopify.com");
    clock.advance(1001);
    expect(store.consume(s, "foo.myshopify.com")).toBe(false);
  });

  it("sweeps expired entries on the next issue", () => {
    const clock = makeClock();
    const store = createInMemoryStateStore({
      ttlMs: 1000,
      now: clock.now,
      randomHex: counterRng(),
    });
    store.issue("a.myshopify.com");
    store.issue("b.myshopify.com");
    expect(store.size()).toBe(2);
    clock.advance(1001);
    store.issue("c.myshopify.com");
    expect(store.size()).toBe(1);
  });

  it("rejects unknown state values", () => {
    const store = createInMemoryStateStore();
    expect(store.consume("never-issued", "foo.myshopify.com")).toBe(false);
  });
});
