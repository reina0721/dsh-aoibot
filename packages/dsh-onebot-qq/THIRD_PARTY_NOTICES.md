# Third-party notices

`dsh-onebot-qq` is a DeepSeek Harness plugin for the OneBot v11 protocol, distributed under the MIT
License (see `LICENSE`, Copyright (c) 2026 dsh-bot contributors). It has **no third-party runtime
dependencies**: the host half uses Node.js built-in modules only (`node:http`, `node:crypto`, `fetch`,
`WebSocket`), and the browser half uses the React instance injected by DeepSeek Harness.

The following upstream works are reused, adapted, or referenced. Header comments in each source file
record its origin where code was adapted.

## aureth-labs/dsh-aurabot-qq

- Upstream: <https://github.com/aureth-labs/dsh-aurabot-qq> (repository metadata also points to
  <https://github.com/accomplish07zrh-eng/dsh-aurabot-qq>)
- License: MIT, Copyright (c) 2026 Aurabot contributors
- Why reused: Aurabot is a mature DSH plugin that already ships a working SnowLuma / OneBot v11
  connection layer, a data-persisting host, and a full-page web panel. This package reuses its proven
  structure instead of reinventing those wheels; only the OneBot v11 connectivity layer is kept and
  the AI-chat/persona features are intentionally out of scope (they belong to later cognitive plugins).

Reused/adapted files:

| This package | Upstream (Aurabot) | What was reused |
|---|---|---|
| `src/onebot/client.js` | `src/onebot/client.js` | OneBot v11 HTTP/WS client, echo correlation, reconnect loop. Adapted: all backoff/jitter/timeout/retry values come from plugin config, added three HTTP auth modes, connection statistics, and a configurable WS handshake timeout. |
| `src/core/store.js` | `src/core/store.js` | Data-directory resolution, atomic JSON write, JSONL append/rotation. Adapted with this package's own data directory name. |
| `src/core/redact.js` | `src/core/redact.js` | Secret/token redaction rules for logs and error messages. |
| `src/core/logger.js` | `src/core/logger.js` | Leveled logger with an in-memory ring buffer. Adapted: configurable level/buffer size/persistence and monotonic sequence numbers for incremental panel polling. |
| `src/gateway/snowluma.js` | `src/snowluma/manager.js` | `detectInstall()` and `readOneBotEndpoint()` (read-only subset). Adapted: removed process management/password injection/launching (not needed, and SnowLuma's EULA restricts automated deployment); fixed the server-enabled check to accept SnowLuma 2.x `enabled` as well as `enable`. |
| `client.js` | `client/client.js` | Panel structure, DSH theme-token usage, form-control and tab patterns, `ctx.slots` registration and `window.__ModuleLoader__` manifest form. Rewritten for this plugin's six tabs and data-driven config form. |
| `test/helpers/mock-onebot.js` | `test/helpers/mock-onebot.js` | In-memory OneBot v11 mock gateway (HTTP + WS framing). Extended with token-auth modes, delay/failure injection, event-push helpers and wait helpers. |
| `test/helpers/fake-dsh.js` | `test/helpers/fake-dsh.js` | Minimal fake DSH context (`webServer`, `effect`, `logger`, `get`) for host-level tests. Reduced to only the services this package uses. |

MIT license text of the upstream work (required notice):

```
MIT License

Copyright (c) 2026 Aurabot contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DeepSeek Harness

- Upstream: <https://github.com/deepseek-ai/deepseek-harness>
- License: MIT, Copyright (c) 2026 DeepSeek
- Reused: the bundle/client-plugin contract (`dsh.bundle.patch`, `dsh.client`, `window.__ModuleLoader__`
  registration), the DSH web UI theme tokens (`--dsw-alias-*`, `--dsw-radius-*`, `--dsw-font-*`) and the
  UI/UX rules from the shipped `dsh-client-ui-ux` / `dsh-responsive-ui` skills and `docs/web-styling.md`,
  `docs/ui-radius.md`. No DSH source files are copied into this package.

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## OneBot v11 specification

- Upstream: <https://github.com/botuniverse/onebot-11>
- References: the event/action shapes, `message_format` (`string` vs `array`), CQ-code escaping and the
  `{status, retcode, data}` response envelope implemented by this package follow the OneBot v11
  specification. See `docs/RESEARCH-onebot-ecosystem.md` for the verified clause-level references.

## QQ gateways (not bundled)

NapCat, SnowLuma, Lagrange.OneBot and LLOneBot are independent third-party projects with their own
licenses and terms. This package **does not bundle, distribute, download, launch or inject** any of
them. It only connects to an address that the user already runs and configures. SnowLuma is treated as
read-only configuration (`docs/USER-MANUAL.md` explains why: its EULA restricts automated deployment);
all gateway names and links are listed in `docs/RESEARCH-onebot-ecosystem.md`.

- NapCat: <https://github.com/NapNeko/NapCatQQ>
- SnowLuma: <https://github.com/SnowLuma/SnowLuma>
- Lagrange.OneBot: <https://github.com/LagrangeDev/Lagrange.Core>
- LLOneBot: <https://github.com/LLOneBot/LLOneBot>
