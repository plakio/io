# Plugins

io uses OpenCode's plugin API. Project and global plugins are loaded automatically from:

```text
.opencode/plugin/*.ts
~/.config/io/opencode/plugin/*.ts
```

A plugin is an `@opencode/plugin` definition. The Promise API is the shortest path:

```ts
import { Plugin } from "@opencode/plugin";

export const MyPlugin = Plugin.define({
  id: "my-plugin",
  async setup(ctx) {
    // ctx exposes tools, agents, commands, skills, events, sessions, etc.
    void (async () => {
      for await (const event of ctx.event.subscribe()) {
        if (event.type === "session.idle") {
          // react to an idle session
        }
      }
    })();
  },
});
```

The Effect API is available from `@opencode/plugin/effect` and is what io's built-in shell/security plugin uses:

```ts
import { define, Effect } from "@opencode/plugin/effect";

export const MyPlugin = define({
  id: "my-effect-plugin",
  effect: Effect.fn(function* (ctx) {
    // yield* ctx.tool.transform(...)
  }),
});
```

Project tools live in `.opencode/tool/*.ts`, project commands in
`.opencode/command/*.md`, project agents in `.opencode/agent/*.md`, and skills in
`.opencode/skills/*/SKILL.md`. All of them are loaded because io enables project
configuration on the embedded host.

ACP/editor integration is not implemented yet; it is tracked in issue #49.
