// ---------------------------------------------------------------------------
// readline-backed interactive prompts.
//
// A thin functional layer over `node:readline` that exposes ask / askYesNo /
// askChoice / askSecret. The underlying IO is injectable (`PromptIO`) so tests
// can stub stdin without spawning a subprocess.
//
// For `askSecret`, we flip the terminal into raw mode and manually consume
// bytes so that the password never appears on the user's screen. If the
// stream is non-TTY (e.g. piped stdin in CI) we fall back to a plain readline
// read — printing a warning that the secret will echo.
// ---------------------------------------------------------------------------

import * as readline from "node:readline";

export interface PromptIO {
  ask(question: string): Promise<string | null>;
  askSecret(question: string): Promise<string | null>;
  error?(message: string): void;
  close(): void;
}

export interface AskOptions {
  readonly default?: string;
  /** Return null to accept, or a string error message to reject and re-ask. */
  readonly validate?: (value: string) => string | null;
}

export interface YesNoOptions {
  readonly default?: boolean;
}

export interface Choice {
  readonly key: string;
  readonly label: string;
}

export interface Prompter {
  ask(question: string, opts?: AskOptions): Promise<string>;
  askYesNo(question: string, opts?: YesNoOptions): Promise<boolean>;
  askChoice(question: string, choices: readonly Choice[]): Promise<string>;
  askSecret(question: string): Promise<string>;
  close(): void;
}

export function createPrompter(io: PromptIO): Prompter {
  return {
    async ask(question, opts = {}) {
      while (true) {
        const raw = await io.ask(decorate(question, opts));
        const value = raw === null || raw === "" ? (opts.default ?? "") : raw;
        const err = opts.validate?.(value) ?? null;
        if (err === null) return value;
        (io.error ?? ((m: string) => process.stderr.write(`${m}\n`)))(
          `  ↳ ${err}`,
        );
      }
    },

    async askYesNo(question, opts = {}) {
      const def = opts.default;
      const suffix = def === true ? "[Y/n]" : def === false ? "[y/N]" : "[y/n]";
      while (true) {
        const raw = await io.ask(`${question} ${suffix} `);
        const value = (raw ?? "").trim().toLowerCase();
        if (value === "" && def !== undefined) return def;
        if (value === "y" || value === "yes") return true;
        if (value === "n" || value === "no") return false;
      }
    },

    async askChoice(question, choices) {
      // Arrow-key selection when we have a real TTY, so users don't have to
      // type letter keys. Non-TTY path (tests, piped input) keeps the old
      // letter prompt so existing PromptIO mocks still drive the flow.
      if (process.stdin.isTTY && process.stdout.isTTY) {
        return arrowSelect(question, choices);
      }
      const rendered =
        `${question}\n` +
        choices.map((c) => `  (${c.key}) ${c.label}`).join("\n") +
        "\n> ";
      while (true) {
        const raw = await io.ask(rendered);
        const value = (raw ?? "").trim().toLowerCase();
        const match = choices.find((c) => c.key.toLowerCase() === value);
        if (match) return match.key;
      }
    },

    async askSecret(question) {
      const raw = await io.askSecret(question);
      return raw ?? "";
    },

    close() {
      io.close();
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Default IO bound to node:readline + process.stdin                          */
/* -------------------------------------------------------------------------- */

export function defaultPromptIO(): PromptIO {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return {
    ask(q) {
      return new Promise((resolve) => {
        rl.question(q, (answer) => resolve(answer));
        rl.once("close", () => resolve(null));
      });
    },
    askSecret(q) {
      return new Promise((resolve) => {
        process.stdout.write(q);
        const stdin = process.stdin;
        if (!stdin.isTTY) {
          rl.once("line", (line) => resolve(line));
          return;
        }
        stdin.setRawMode(true);
        let buf = "";
        const onData = (chunk: Buffer): void => {
          for (const byte of chunk) {
            if (byte === 0x03) {
              // ctrl-c
              stdin.setRawMode(false);
              stdin.off("data", onData);
              process.stdout.write("\n");
              process.exit(130);
            }
            if (byte === 0x0a || byte === 0x0d) {
              stdin.setRawMode(false);
              stdin.off("data", onData);
              process.stdout.write("\n");
              resolve(buf);
              return;
            }
            if (byte === 0x7f || byte === 0x08) {
              if (buf.length > 0) buf = buf.slice(0, -1);
              continue;
            }
            buf += String.fromCharCode(byte);
          }
        };
        stdin.on("data", onData);
      });
    },
    close() {
      rl.close();
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function decorate(question: string, opts: AskOptions): string {
  if (opts.default !== undefined && opts.default !== "") {
    return `${question} [${opts.default}] `;
  }
  return `${question} `;
}

/* -------------------------------------------------------------------------- */
/*  Arrow-key choice selector (interactive TTY only)                           */
/* -------------------------------------------------------------------------- */

const ESC = "\x1b";
const COLOR_CYAN = `${ESC}[36m`;
const COLOR_DIM = `${ESC}[2m`;
const COLOR_RESET = `${ESC}[0m`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

/**
 * Draw a vertically-stacked list of choices with a `❯` marker on the
 * current selection, and let the user move it with ↑/↓, commit with Enter.
 *
 * On Ctrl+C: exits the process (matches readline default).
 * On non-TTY: caller should skip this and use letter-input instead —
 * we assume the callsite checked `isTTY`.
 */
async function arrowSelect(
  question: string,
  choices: readonly Choice[],
): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const initialIndex = 0;
  let cursor = initialIndex;

  // First draw: question + list. We track how many lines we wrote so we can
  // clear-and-redraw on each keystroke.
  stdout.write(`${question}\n`);
  const render = (): void => {
    for (let i = 0; i < choices.length; i++) {
      const c = choices[i];
      const sel = i === cursor;
      const marker = sel ? `${COLOR_CYAN}❯${COLOR_RESET}` : " ";
      const body = sel ? c.label : `${COLOR_DIM}${c.label}${COLOR_RESET}`;
      stdout.write(`  ${marker}  ${body}\n`);
    }
  };
  const clearList = (): void => {
    // Move up N lines + clear each.
    stdout.write(`${ESC}[${choices.length}A`);
    for (let i = 0; i < choices.length; i++) {
      stdout.write(`${ESC}[2K`);
      if (i < choices.length - 1) stdout.write(`${ESC}[1B`);
    }
    // Cursor is now on the last cleared line. Move back to top so next
    // render rewrites in place.
    stdout.write(`${ESC}[${choices.length - 1}A\r`);
  };
  render();
  stdout.write(HIDE_CURSOR);

  return new Promise<string>((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = (): void => {
      stdin.off("data", onData);
      if (!wasRaw) stdin.setRawMode(false);
      stdout.write(SHOW_CURSOR);
    };

    const onData = (chunk: Buffer): void => {
      const s = chunk.toString();
      // Ctrl+C.
      if (s === "\x03") {
        cleanup();
        stdout.write("\n");
        process.exit(130);
      }
      // Enter: accept current.
      if (s === "\r" || s === "\n") {
        cleanup();
        // Clear the list + re-draw a single summary line so the choice
        // isn't left half-rendered.
        clearList();
        for (let i = 0; i < choices.length; i++) {
          stdout.write(`${ESC}[2K\n`);
        }
        stdout.write(`${ESC}[${choices.length}A`);
        stdout.write(
          `  ${COLOR_CYAN}❯${COLOR_RESET}  ${choices[cursor].label}\n`,
        );
        resolve(choices[cursor].key);
        return;
      }
      // Arrow keys come in as ESC [ A/B/C/D.
      if (s === "\x1b[A" || s === "k") {
        // Up.
        cursor = (cursor - 1 + choices.length) % choices.length;
        clearList();
        render();
        return;
      }
      if (s === "\x1b[B" || s === "j") {
        // Down.
        cursor = (cursor + 1) % choices.length;
        clearList();
        render();
        return;
      }
      // Number key shortcut: 1..N picks directly.
      const n = parseInt(s, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= choices.length) {
        cursor = n - 1;
        clearList();
        render();
      }
      // Ignore everything else.
    };

    stdin.on("data", onData);
  });
}
