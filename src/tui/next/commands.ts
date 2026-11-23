import type { IoCommand } from "./keymap.js";

/**
 * OpenCode-first defaults. `<leader>` expands to `Ctrl+X`.
 * These are bindings, not handlers: the app wires each id to its action.
 */
export const DEFAULT_KEYBINDINGS: Readonly<Record<string, readonly string[]>> = {
	"command.palette.show": ["ctrl+p"],
	"model.list": ["<leader>m"],
	"model.variant.cycle": ["ctrl+t"],
	"agent.cycle": ["shift+tab"],
	"session.list": ["<leader>l"],
	"session.new": ["<leader>n"],
	"session.compact": ["<leader>c"],
	"session.interrupt": ["escape"],
	"prompt.queue": ["<leader>return"],
	"queued.prompts": ["<leader>q"],
	"diff.open": ["<leader>d"],
	"tool.output.toggle": ["<leader>o"],
	"thinking.toggle": ["<leader>t"],
	"verbosity.cycle": ["<leader>v"],
	"tps.toggle": ["<leader>p"],
	"theme.switch": ["<leader>h"],
	"which-key.toggle": ["ctrl+alt+k"],
	"app.exit": ["ctrl+c", "ctrl+d"],
};

const TITLES: Readonly<Record<string, { title: string; description: string }>> = {
	"command.palette.show": { title: "Command palette", description: "Search and run commands" },
	"model.list": { title: "Select model", description: "Choose a provider, model and variant" },
	"model.variant.cycle": { title: "Cycle model variant", description: "Next reasoning variant" },
	"agent.cycle": { title: "Cycle agent", description: "Switch primary or subagent" },
	"session.list": { title: "Resume session", description: "Switch to an earlier session" },
	"session.new": { title: "New session", description: "Start a fresh session" },
	"session.compact": { title: "Compact context", description: "Summarize the current context" },
	"session.interrupt": { title: "Interrupt session", description: "Stop the current turn" },
	"prompt.queue": { title: "Queue prompt", description: "Send after the current turn" },
	"queued.prompts": { title: "Manage queued prompts", description: "Edit, delete, reorder or steer" },
	"diff.open": { title: "Show diff", description: "Review working-copy changes" },
	"tool.output.toggle": { title: "Toggle tool output", description: "Expand or collapse tool cards" },
	"thinking.toggle": { title: "Toggle thinking", description: "Show or hide model reasoning" },
	"verbosity.cycle": { title: "Cycle verbosity", description: "Low, normal, high or debug" },
	"tps.toggle": { title: "Toggle tokens per second", description: "Show or hide output speed" },
	"theme.switch": { title: "Switch theme", description: "Dark, light or system" },
	"which-key.toggle": { title: "Show keybindings", description: "Open the which-key panel" },
	"app.exit": { title: "Exit io", description: "Close the current session" },
};

export function createIoCommands(
	handlers: Partial<Record<string, () => void | Promise<void>>>,
): IoCommand[] {
	return Object.entries(DEFAULT_KEYBINDINGS).map(([id, keys]) => {
		const meta = TITLES[id] ?? { title: id, description: "" };
		return {
			id,
			title: meta.title,
			description: meta.description,
			keys,
			run: handlers[id] ?? (() => {}),
		};
	});
}
