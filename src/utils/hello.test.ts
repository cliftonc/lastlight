import { describe, expect, it, vi, afterEach } from "vitest";
import { hello } from "./hello.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hello", () => {
  it("prints a greeting for Alice", () => {
    const spy = vi.spyOn(console, "log");
    hello("Alice");
    expect(spy).toHaveBeenCalledWith("Hello Alice!");
  });

  it("prints a greeting for Bob", () => {
    const spy = vi.spyOn(console, "log");
    hello("Bob");
    expect(spy).toHaveBeenCalledWith("Hello Bob!");
  });
});
