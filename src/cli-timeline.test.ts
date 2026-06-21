import { describe, it, expect } from "vitest";
import {
  classifyTool,
  formatToolName,
  summarizeResult,
  renderArgs,
  renderTimeline,
} from "./cli-timeline.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("classifyTool", () => {
  it("classifies by family", () => {
    expect(classifyTool("read")).toBe("fs");
    expect(classifyTool("bash")).toBe("shell");
    expect(classifyTool("github_get_repository")).toBe("git");
    expect(classifyTool("mcp_github_list_labels")).toBe("git");
    expect(classifyTool("web_fetch")).toBe("web");
    expect(classifyTool("something_else")).toBe("other");
  });
});

describe("formatToolName", () => {
  it("drops github / mcp prefixes", () => {
    expect(formatToolName("github_get_repository")).toBe("get_repository");
    expect(formatToolName("mcp_github_list_labels")).toBe("list_labels");
    expect(formatToolName("mcp_slack_post")).toBe("slack.post");
    expect(formatToolName("read")).toBe("read");
  });
});

describe("renderArgs", () => {
  it("summarizes common tools", () => {
    expect(renderArgs("read", { path: "src/x.ts" })).toBe("src/x.ts");
    expect(renderArgs("bash", { command: "npm ci" })).toBe("npm ci");
    expect(renderArgs("grep", { pattern: "foo", path: "src" })).toBe("/foo/ in src");
    expect(renderArgs("github_get_repository", { owner: "o", repo: "r" })).toContain("owner: o");
  });
});

describe("summarizeResult", () => {
  it("summarizes plain text by first non-blank line + line count", () => {
    const s = summarizeResult("\n# Title\nbody\nmore");
    expect(s.kind).toBe("text");
    if (s.kind === "text") {
      expect(s.preview).toBe("# Title");
      expect(s.lines).toBe(4);
    }
  });

  it("unwraps an MCP envelope string to its inner text", () => {
    const env = JSON.stringify({ content: [{ type: "text", text: "# Plan\nstuff" }] });
    const s = summarizeResult(env);
    expect(s.kind).toBe("text");
    if (s.kind === "text") expect(s.preview).toBe("# Plan");
  });

  it("summarizes an object by identity field", () => {
    const s = summarizeResult({ name: "lastlight", id: 1, owner: {} });
    expect(s.kind).toBe("json");
    if (s.kind === "json") expect(s.preview).toBe("name: lastlight");
  });

  it("reports array length", () => {
    const s = summarizeResult([{ name: "a" }, { name: "b" }]);
    expect(s.kind).toBe("array");
    if (s.kind === "array") expect(s.length).toBe(2);
  });

  it("treats null/empty as empty", () => {
    expect(summarizeResult(null).kind).toBe("empty");
    expect(summarizeResult("").kind).toBe("empty");
  });
});

describe("renderTimeline", () => {
  it("pairs a tool call with its result and renders prose", () => {
    const messages = [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: "Reading the file.",
        tool_calls: [{ id: "call_1", function: { name: "read", arguments: { path: "a.ts" } } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "line one\nline two" },
    ];
    const out = renderTimeline(messages).map(stripAnsi);
    const text = out.join("\n");
    expect(text).toContain("user");
    expect(text).toContain("do the thing");
    expect(text).toContain("assistant");
    expect(text).toContain("read");
    expect(text).toContain("a.ts");
    // result preview + line/byte meta, paired under the call
    expect(text).toContain("line one");
    expect(text).toMatch(/2 lines/);
    // no raw JSON envelope leaked through
    expect(text).not.toContain('"tool_call_id"');
  });

  it("skips an assistant turn with no text and no tool calls", () => {
    const out = renderTimeline([{ role: "assistant", content: "" }]);
    expect(out).toHaveLength(0);
  });

  it("does not double-render a paired tool result as a standalone row", () => {
    const messages = [
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "bash", arguments: { command: "ls" } } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ];
    const out = renderTimeline(messages).map(stripAnsi);
    // one call row + one result row = 2 lines (no extra orphan result)
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("bash");
    expect(out[1]).toContain("ok");
  });
});
