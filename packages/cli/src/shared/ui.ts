// ---------------------------------------------------------------------------
// Lightweight terminal-UI primitives for the CLI wizard.
//
// No external deps: ANSI escape codes + a small spinner driver backed by
// setInterval. Colour output auto-disables when stdout is not a TTY or
// NO_COLOR is set (https://no-color.org/) so pipe / CI output stays clean.
// ---------------------------------------------------------------------------

/* eslint-disable no-control-regex */

export interface UiOptions {
  readonly stream?: NodeJS.WriteStream;
  readonly colorOverride?: boolean;
}

/** Reset all ANSI styles. */
const RESET = "\x1b[0m";

type StyleFn = (s: string) => string;

export interface Styles {
  readonly dim: StyleFn;
  readonly bold: StyleFn;
  readonly green: StyleFn;
  readonly red: StyleFn;
  readonly yellow: StyleFn;
  readonly cyan: StyleFn;
  readonly magenta: StyleFn;
  readonly gray: StyleFn;
}

function makeStyles(colorOn: boolean): Styles {
  const w = (code: string): StyleFn =>
    colorOn ? (s: string) => `${code}${s}${RESET}` : (s: string) => s;
  return {
    dim: w("\x1b[2m"),
    bold: w("\x1b[1m"),
    green: w("\x1b[32m"),
    red: w("\x1b[31m"),
    yellow: w("\x1b[33m"),
    cyan: w("\x1b[36m"),
    magenta: w("\x1b[35m"),
    gray: w("\x1b[90m"),
  };
}

/**
 * Strip ANSI for width calculations. Intentionally covers only the codes
 * we actually emit from `makeStyles`; a full ANSI parser isn't worth it.
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export interface Ui {
  readonly s: Styles;
  /** True if colour is active on the attached stream. */
  readonly color: boolean;

  /** Print a line ending with newline. */
  line(text?: string): void;

  /** Render a "✓  label  value" row. Icon colour = green. */
  ok(label: string, value?: string): void;

  /** Render a "⚠  label  detail" row in yellow. */
  warn(label: string, detail?: string): void;

  /** Section header: bold magenta "┃  text". */
  section(title: string): void;

  /** A boxed URL for "copy this into your browser" moments. */
  highlightUrl(url: string): void;

  /** Start a spinner with `text`. Returns a handle with `update` + `stop`. */
  spinner(text: string): Spinner;

  /** Horizontal rule for delimiting setup-done / runtime / shutdown sections. */
  separator(): void;
}

export interface Spinner {
  /** Update the text shown next to the spinner. Preserves frame. */
  update(text: string): void;
  /** Stop spinning and either leave a ✓/✗ line or clear. */
  succeed(text?: string): void;
  fail(text?: string): void;
  clear(): void;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

export function createUi(opts: UiOptions = {}): Ui {
  const stream = opts.stream ?? process.stdout;
  const envNoColor = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "";
  const colorOn =
    opts.colorOverride !== undefined
      ? opts.colorOverride
      : stream.isTTY === true && !envNoColor;
  const s = makeStyles(colorOn);

  function write(text: string): void {
    stream.write(text);
  }

  const ui: Ui = {
    s,
    color: colorOn,

    line(text = "") {
      write(text + "\n");
    },

    ok(label, value) {
      const icon = s.green("✓");
      const labelCol = pad(label, 20);
      const tail = value ? `  ${s.dim(value)}` : "";
      write(`  ${icon}  ${labelCol}${tail}\n`);
    },

    warn(label, detail) {
      const icon = s.yellow("⚠");
      const labelCol = pad(label, 20);
      const tail = detail ? `  ${s.dim(detail)}` : "";
      write(`  ${icon}  ${labelCol}${tail}\n`);
    },

    section(title) {
      write(`\n  ${s.magenta("┃")}  ${s.bold(title)}\n\n`);
    },

    highlightUrl(url) {
      // Simple padded box. Width = url length + 4, capped at 80.
      const inner = ` ${url} `;
      const width = Math.min(Math.max(inner.length, 40), 80);
      const top = s.cyan("╭" + "─".repeat(width) + "╮");
      const mid = s.cyan("│") + " " + s.cyan(url) + " ".repeat(Math.max(0, width - url.length - 2)) + s.cyan("│");
      const bot = s.cyan("╰" + "─".repeat(width) + "╯");
      write(`\n  ${top}\n  ${mid}\n  ${bot}\n\n`);
    },

    spinner(text) {
      return makeSpinner(stream, s, text, colorOn);
    },

    separator() {
      // Terminal columns; fall back to 72 when not a TTY (shouldn't happen
      // in normal use since ui is auto-disabled there, but be safe).
      const w = Math.min((stream.columns ?? 72) - 4, 72);
      write(`\n  ${s.gray("─".repeat(w))}\n\n`);
    },
  };

  return ui;
}

function pad(str: string, width: number): string {
  const bare = stripAnsi(str);
  if (bare.length >= width) return str;
  return str + " ".repeat(width - bare.length);
}

function makeSpinner(
  stream: NodeJS.WriteStream,
  s: Styles,
  initial: string,
  animate: boolean,
): Spinner {
  let text = initial;
  let frameIdx = 0;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  function clearLine(): void {
    if (stream.isTTY) {
      stream.write("\r\x1b[2K");
    }
  }

  function render(): void {
    if (stopped) return;
    clearLine();
    const frame = animate ? s.cyan(FRAMES[frameIdx]) : s.cyan("·");
    stream.write(`  ${frame}  ${text}`);
    if (animate) {
      frameIdx = (frameIdx + 1) % FRAMES.length;
    }
  }

  if (animate && stream.isTTY) {
    render();
    timer = setInterval(render, FRAME_MS);
    timer.unref?.();
  } else {
    // Non-TTY: emit a single line, no animation.
    stream.write(`  ·  ${text}\n`);
  }

  function stop(status: "ok" | "fail" | "clear", finalText?: string): void {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    clearLine();
    if (status === "clear") return;
    const icon = status === "ok" ? s.green("✓") : s.red("✗");
    stream.write(`  ${icon}  ${finalText ?? text}\n`);
  }

  return {
    update(next) {
      text = next;
      if (animate && !stopped) render();
    },
    succeed(final) {
      stop("ok", final);
    },
    fail(final) {
      stop("fail", final);
    },
    clear() {
      stop("clear");
    },
  };
}

/** Helper: short-hash a hex string for display, "0xabcd…ef12". */
export function shortHex(hex: string, keepPrefix = 6, keepSuffix = 4): string {
  if (!hex || hex.length <= keepPrefix + keepSuffix + 1) return hex;
  return `${hex.slice(0, keepPrefix)}…${hex.slice(-keepSuffix)}`;
}
