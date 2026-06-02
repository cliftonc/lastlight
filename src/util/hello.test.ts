import { afterEach, describe, expect, it, vi } from "vitest";
import { sayHello } from "./hello.js";

describe("sayHello", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints 'Hello <name>!' to stdout", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    sayHello("World");

    expect(logSpy).toHaveBeenCalledWith("Hello World!");
  });

  it("handles empty name without throwing", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    sayHello("");

    expect(logSpy).toHaveBeenCalledWith("Hello !");
  });
});
