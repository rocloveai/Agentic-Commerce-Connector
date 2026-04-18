import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dispatch } from "../acc.js";

describe("dispatch", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });

  it("returns 0 on `acc help`", async () => {
    const code = await dispatch(["help"]);
    expect(code).toBe(0);
    const output = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("acc — Agentic Commerce Connector CLI");
  });

  it("returns 0 on `acc version` and prints a version string", async () => {
    const code = await dispatch(["version"]);
    expect(code).toBe(0);
    const output = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toMatch(/^acc \d+\.\d+\.\d+/);
  });

  it("returns 2 on unknown command and writes to stderr", async () => {
    const code = await dispatch(["frobnicate"]);
    expect(code).toBe(2);
    const errOut = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(errOut).toContain("unknown command");
  });

  it("returns 0 on a placeholder command", async () => {
    const code = await dispatch(["status"]);
    expect(code).toBe(0);
    const output = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("not implemented yet");
  });

  it("delegates `skill edit` to its stub handler and returns 0", async () => {
    const code = await dispatch(["skill", "edit"]);
    expect(code).toBe(0);
    const output = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("not yet implemented");
  });
});
