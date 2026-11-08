export class PromptCancelled extends Error {
	constructor(message = "cancelled") {
		super(message);
		this.name = "PromptCancelled";
	}
}

export interface SelectOption {
	id: string;
	label: string;
	description?: string;
}

interface PendingLine {
	secret: boolean;
	resolve: (value: string) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function stripTerminalSequences(value: string): string {
	return value
		.split(BRACKETED_PASTE_START)
		.join("")
		.split(BRACKETED_PASTE_END)
		.join("")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * Tiny line reader for authentication flows. It intentionally handles only the
 * input those flows need: text, secrets, and numbered selections. Secrets are
 * never echoed and are never written to logs.
 */
export class LinePrompter {
	private readonly input: NodeJS.ReadStream;
	private readonly output: NodeJS.WriteStream;
	private readonly isTTY: boolean;
	private buffer = "";
	private pending: PendingLine | undefined;
	private closed = false;
	private rawModeWasSet = false;
	private skipNextLineFeed = false;
	onInterrupt?: () => void;

	private readonly onData = (chunk: string | Buffer) => {
		this.handleInput(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
	};

	private readonly onEnd = () => {
		this.failPending(new PromptCancelled("input closed"));
	};

	private readonly onError = (error: Error) => {
		this.failPending(error);
	};

	constructor(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout) {
		this.input = input;
		this.output = output;
		this.isTTY = Boolean(input.isTTY);
		if (this.isTTY && typeof input.setRawMode === "function") {
			input.setRawMode(true);
			this.rawModeWasSet = true;
		}
		input.setEncoding("utf8");
		input.resume();
		input.on("data", this.onData);
		input.on("end", this.onEnd);
		input.on("error", this.onError);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.failPending(new PromptCancelled("cancelled"));
		this.input.off("data", this.onData);
		this.input.off("end", this.onEnd);
		this.input.off("error", this.onError);
		if (this.rawModeWasSet && typeof this.input.setRawMode === "function") {
			this.input.setRawMode(false);
		}
		if (this.input.isTTY) this.input.pause();
	}

	private failPending(error: Error): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;
		if (pending.signal && pending.onAbort) {
			pending.signal.removeEventListener("abort", pending.onAbort);
		}
		pending.reject(error);
	}

	private handleInput(raw: string): void {
		const input = stripTerminalSequences(raw).replace(/\r\n/g, "\n");
		for (const char of input) {
			if (char === "\x03") {
				this.skipNextLineFeed = false;
				this.output.write("\n");
				if (this.pending) {
					this.failPending(new PromptCancelled("cancelled"));
				} else {
					this.onInterrupt?.();
				}
				continue;
			}

			if (char === "\n" && this.skipNextLineFeed) {
				this.skipNextLineFeed = false;
				continue;
			}
			if (char === "\r" || char === "\n") {
				this.skipNextLineFeed = char === "\r";
				this.buffer += "\n";
				if (this.pending) this.resolveLine();
				continue;
			}
			this.skipNextLineFeed = false;

			if (char === "\x7f" || char === "\b") {
				if (this.buffer.length > 0) {
					this.buffer = this.buffer.slice(0, -1);
					if (this.isTTY && this.pending && !this.pending.secret) {
						this.output.write("\b \b");
					}
				}
				continue;
			}

			const code = char.charCodeAt(0);
			if (code < 32 || code === 127) continue;

			this.buffer += char;
			if (this.isTTY && this.pending && !this.pending.secret) {
				this.output.write(char);
			}
		}
	}

	private resolveLine(): void {
		const pending = this.pending;
		if (!pending) return;
		const newlineIndex = this.buffer.search(/[\r\n]/);
		const line = newlineIndex === -1 ? this.buffer : this.buffer.slice(0, newlineIndex);
		this.buffer = newlineIndex === -1 ? "" : this.buffer.slice(newlineIndex + 1).replace(/^\n/, "");
		this.pending = undefined;
		if (pending.signal && pending.onAbort) {
			pending.signal.removeEventListener("abort", pending.onAbort);
		}
		if (this.isTTY && !pending.secret) this.output.write("\n");
		pending.resolve(line.trim());
	}

	readLine(message: string, options: { secret?: boolean; signal?: AbortSignal } = {}): Promise<string> {
		if (this.closed) return Promise.reject(new PromptCancelled("cancelled"));
		if (this.pending) return Promise.reject(new Error("another prompt is already active"));
		if (options.signal?.aborted) return Promise.reject(new PromptCancelled("cancelled"));

		this.output.write(message);
		return new Promise<string>((resolve, reject) => {
			const pending: PendingLine = {
				secret: options.secret === true,
				resolve,
				reject,
				signal: options.signal,
			};
			if (options.signal) {
				const onAbort = () => {
					this.failPending(new PromptCancelled("cancelled"));
				};
				pending.onAbort = onAbort;
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
			this.pending = pending;
			if (this.buffer.includes("\n") || this.buffer.includes("\r")) {
				this.resolveLine();
			}
		});
	}

	async select(message: string, options: readonly SelectOption[], signal?: AbortSignal): Promise<string> {
		if (options.length === 0) throw new Error("no options to select");
		this.output.write(`${message}\n`);
		for (let index = 0; index < options.length; index++) {
			const option = options[index];
			if (!option) continue;
			const description = option.description ? ` — ${option.description}` : "";
			this.output.write(`  ${index + 1}. ${option.label}${description}\n`);
		}
		for (;;) {
			const answer = (await this.readLine("> ", { signal })).trim();
			if (answer.length === 0) {
				const first = options[0];
				if (first) return first.id;
			}
			const number = Number(answer);
			if (Number.isInteger(number) && number >= 1 && number <= options.length) {
				const selected = options[number - 1];
				if (selected) return selected.id;
			}
			const match = options.find(
				(option) =>
					option.id.toLowerCase() === answer.toLowerCase() ||
					option.label.toLowerCase() === answer.toLowerCase(),
			);
			if (match) return match.id;
			this.output.write("Invalid selection. Enter a number or name.\n");
		}
	}
}
