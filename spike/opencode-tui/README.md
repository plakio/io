# Spike: OpenTUI + OpenCode SDK

Prueba de concepto para el issue [#20](https://github.com/plakio/io/issues/20): comprobar que OpenTUI y el motor OpenCode pueden convivir en el mismo proceso y que existe un camino de empaquetado.

## Qué prueba

- `@opencode/sdk@2.3.2` crea un host embebido con sesiones, modelos y eventos.
- `@opentui/core@0.9.7` renderiza un frame con el texto que llega del motor.
- Un proveedor OpenAI-compatible mock, servido desde `node:http`, evita credenciales y red.
- El test renderer de OpenTUI captura el frame final.
- La configuración global de OpenCode se aísla con `config.directory` + `config.project: false`.

## Ejecutar

Requiere Node.js 26.4+ o Bun 1.3.14+.

```bash
npm install --ignore-scripts
npm run patch:ws
npm start          # Node 26 + --experimental-ffi
# o
npm run start:bun  # Bun
```

`npm run patch:ws` aplica un parche local a `@effect/platform-node-shared/dist/NodeWS.js`. Sin ese parche, el bundle de Bun genera `__reExport(exports_NodeWS, ws2)` con `ws2` indefinido. Es un problema de interop CJS/ESM de Bun con `ws`, no del motor.

## Build de binario

```bash
npx bun build --compile spike.mjs --outfile spike-bin \
  --define 'process.env.OPENTUI_LIBC="glibc"'
```

El binario resultante necesita un sidecar con el paquete nativo de PTY de OpenCode:

```bash
mkdir -p dist/node_modules/@opencode
cp -a node_modules/@opencode/pty-linux-arm64-gnu dist/node_modules/@opencode/
cp spike-bin dist/
cd dist && ./spike-bin
```

El sidecar de PTY no queda embebido en el binario. OpenTUI sí embebe su librería nativa y los assets.

## Resultados medidos

Máquina de prueba: Linux arm64, Node 26.13.1, Bun 1.4.5.

| Runtime | Host create | Prompt mock | RSS | Distribución |
| --- | ---: | ---: | ---: | --- |
| Node 26 (source) | 185 ms | 1.865 s | 392 MB | Requiere `--experimental-ffi` y node_modules |
| Bun 1.4.5 (source) | 197 ms | 1.615 s | 381 MB | Bun + node_modules |
| Bun compilado | 185 ms | 1.427 s | 328 MB | 144 MB + 3.1 MB sidecar PTY |

El frame capturado contiene el texto del mock, lo que confirma el recorrido completo: OpenAI-compatible mock → OpenCode SDK → evento `session.text.delta` → `TextRenderable` de OpenTUI.

## Hallazgos de empaquetado

1. **Bun es el camino más viable** para un binario único, pero hoy necesita:
   - el parche de `NodeWS.js`;
   - el sidecar `@opencode/pty-<platform>`;
   - `@anthropic-ai/claude-agent-sdk` instalado para que Bun resuelva el import estático del provider Claude Agent. Ese paquete agrega ~394 MB a `node_modules`, aunque el binario final queda en 144 MB.
2. **Node 26 funciona en source**, pero no se validó Node SEA. Sería el fallback si Bun no es aceptable.
3. **La configuración global de OpenCode se hereda por defecto**: en la primera prueba se cargó un plugin de `~/.config/opencode/plugins`. Con `config.directory` apuntando a un directorio propio y `config.project: false`, la carga desapareció. Para `io` hay que aislar siempre.
4. **OpenTUI requiere FFI experimental en Node**; Bun evita ese flag y es el runtime recomendado por OpenTUI.
5. **El system prompt de OpenCode sigue presente** en la prueba. En `io` habrá que reemplazarlo con `session.hook("context")` y quitar las herramientas nativas con `tool.transform`.

## Pendiente para el proyecto

- Probar un `createCliRenderer` real en una TTY, no solo el test renderer.
- Probar un tool call real y el flujo `permission.asked`.
- Medir macOS arm64/x64 y Linux x64.
- Resolver si el parche de `ws` se mantiene como `patch-package`, fork o fix upstream.
- Decidir si el sidecar de PTY se acepta o se busca embeberlo.
- Evaluar Node SEA como fallback.

## Archivos

- `spike.mjs`: host OpenCode + render OpenTUI + métricas.
- `mock-server.mjs`: endpoint OpenAI-compatible mock.
- `patches/NodeWS.js`: parche de interop `ws` para Bun.
- `scripts/patch-node-ws.mjs`: aplica el parche.
