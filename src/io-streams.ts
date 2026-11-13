/**
 * Process-wide output state. EPIPE is normal when a caller pipes io into
 * `head`; the shell should stop writing but still let the agent session abort
 * and dispose instead of calling process.exit() from a stream error handler.
 */
let outputBroken = false;
let brokenHandler: (() => void) | undefined;

export function markOutputBroken(): void {
	if (outputBroken) return;
	outputBroken = true;
	brokenHandler?.();
}

export function isOutputBroken(): boolean {
	return outputBroken;
}

export function setOutputBrokenHandler(handler: (() => void) | undefined): void {
	brokenHandler = handler;
}
