import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { CONSENT_TIMEOUT_MS } from "../config.js";

export interface PromptOptions {
  render: (context: { queuedBehind: number }) => string;
  timeoutMs?: number;
  beforeRender?: () => PromptResult | null;
  onResult?: (result: PromptResult) => void;
}

export interface PromptResult {
  answer: string | null;
  timedOut: boolean;
  skipped?: boolean;
}

export interface TerminalInterface {
  prompt(options: PromptOptions): Promise<PromptResult>;
  isInteractive(): boolean;
  write(text: string): void;
  pending(): number;
  close(): void;
}

export interface TerminalOptions {
  input?: Readable;
  output?: Writable;
  interactive?: boolean;
}

/**
 * A terminal owns one lazily-created readline interface. Prompts are queued so
 * output from concurrent MCP calls stays readable and each callback waits for
 * the active answer or timeout before rendering the next prompt.
 */
export function createTerminal(options: TerminalOptions = {}): TerminalInterface {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive =
    options.interactive ??
    ((input as NodeJS.ReadStream).isTTY === true &&
      (output as NodeJS.WriteStream).isTTY === true);
  let reader: readline.Interface | null = null;
  let closed = false;
  let pendingCount = 0;
  let queue = Promise.resolve();

  function getReader(): readline.Interface {
    if (!reader) {
      reader = readline.createInterface({ input, terminal: interactive });
      reader.once("close", () => {
        closed = true;
      });
    }
    return reader;
  }

  function readLine(prompt: string, timeoutMs: number): Promise<PromptResult> {
    if (closed) return Promise.resolve({ answer: null, timedOut: true });
    const activeReader = getReader();
    output.write(prompt);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: PromptResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        activeReader.off("line", onLine);
        activeReader.off("close", onClose);
        resolve(result);
      };
      const onLine = (answer: string) => finish({ answer: answer.trim(), timedOut: false });
      const onClose = () => finish({ answer: null, timedOut: true });
      const timeout = setTimeout(
        () => finish({ answer: null, timedOut: true }),
        timeoutMs
      );
      activeReader.once("line", onLine);
      activeReader.once("close", onClose);
    });
  }

  return {
    prompt(promptOptions): Promise<PromptResult> {
      if (!interactive) return Promise.resolve({ answer: null, timedOut: true });
      pendingCount += 1;
      const result = queue.then(async () => {
        const queuedBehind = Math.max(0, pendingCount - 1);
        const promptResult =
          promptOptions.beforeRender?.() ??
          (await readLine(
            promptOptions.render({ queuedBehind }),
            promptOptions.timeoutMs ?? CONSENT_TIMEOUT_MS
          ));
        promptOptions.onResult?.(promptResult);
        return promptResult;
      });
      queue = result.then(
        () => undefined,
        () => undefined
      );
      return result.finally(() => {
        pendingCount = Math.max(0, pendingCount - 1);
      });
    },
    isInteractive: () => interactive && !closed,
    write: (text) => output.write(text),
    pending: () => pendingCount,
    close: () => {
      closed = true;
      reader?.close();
    },
  };
}

export const terminal = createTerminal();
