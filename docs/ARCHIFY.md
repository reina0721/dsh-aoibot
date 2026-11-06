# Archify 视觉层：安装、验证与回滚

> 安装时间：2026-11-06（Asia/Shanghai）。
> 目标：当前 DSH `web` profile（GUI `http://127.0.0.1:3079`）。
> 结论：已安装并通过 Skill 加载、`doctor`、`demo`、`finalize`（含 browser-check）。本文件记录版本、证据、限制与回滚。

## 1. 它是什么 / 不是什么

**是**：`tt-a1i/archify` 是一个 Agent Skill，把描述、计划或代码库变成可交互的 standalone HTML 图表（architecture / workflow / sequence / dataflow / lifecycle；3.1+ 增加 ERD / class / tree / timeline / waterfall，3.2+ 增加一页解释器）。

**不是**：
- 不是 QQ bot 的「看图 / 生图 / 视觉理解」能力；
- 不是 dsh-bot 面板的组件库；
- 不是运行时代码依赖。dsh-bot 的 `package.json` 不依赖它，插件运行不 import 它。

它的用途是**工程视觉层**：架构图、消息生命周期、状态机、路线图、能力矩阵的可视化，进入 `docs/visuals/`，用于评审和长期维护。

## 2. 安装的版本

| 项 | 值 |
|---|---|
| DSH profile | `web`（`~/.dsh/profiles/web`） |
| DSH | `0.2.2-rc.1` |
| Node | `24.18.0` |
| pnpm | `11.7.0` |
| npm 包 | `@tt-a1i/archify-dsh@1.0.0`（exact pin） |
| 内含 Skill | Archify **3.0.1**（仅 5 种图） |
| 适配器许可 | MIT |
| Skill 许可 | MIT（1.0.0 内含 3.0.1；3.2.0 起 Apache-2.0） |
| 官方验收目标 | DSH `0.1.2-rc.1`；`0.2.2-rc.1` 未官方认证，本机实测通过 |

> 1.1.0 候选（Archify 3.2.0 + ERD/tree/timeline/waterfall/explainer）目标 DSH `0.2.1-rc.2`，**尚未发布 npm**。本机不安装未发布候选。

## 3. 安装方式

```sh
# 实际执行：DSH live 安装（无需重启，热应用）
plugin_manager install_bundle target=@tt-a1i/archify-dsh@1.0.0

# 等价的 CLI 方式（若 live 安装不可用）：
dsh plugin --profile web add @tt-a1i/archify-dsh@1.0.0
```

安装结果：
- `~/.dsh/profiles/web/package.json` 增加依赖并加入 `dsh.profile.bundles`；
- `dsh --profile web --dump-config` 出现一行：

```yaml
- id: archify-skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    providerName: archify-plugin
    includeDefaultRoots: false
    bundledSkillDir: !!js ...resolve('@tt-a1i/archify-dsh/package.json')... 'skills'
```

- Skill catalog 立即出现 `archify`；现有 skill（agent-experience / cordis-* / editing-cordis-compositions）未消失。

安装前备份：`/tmp/archify-install-backup/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml}`。

## 4. 验证证据

```text
node .../skills/archify/bin/archify.mjs doctor
→ Archify is ready.  [ok] Node v24.18.0 / 5 renderers / validators / preview / finalize

node .../bin/archify.mjs demo /tmp/archify-demo
→ /tmp/archify-demo/archify-demo.html
```

5 张视觉产物均通过：

```json
{"ok":true,"gates":{"validate":"pass","deliver":"pass","check":"pass","browser-check":"pass"}}
```

证据 JSON 在 `docs/visuals/evidence/<slug>/`。

## 5. Chrome 与字体（本机特有）

`finalize` 的 `browser-check` 需要真实的 Chrome/Chromium。本机没有系统 Chrome，也没有沙箱权限，因此：

1. 用 `@puppeteer/browsers` 下载 Chrome for Testing 157.0.8103.38 到 `~/.cache/archify-chrome/`；
2. 从 Debian bookworm 包中解出缺失的 `.so` 到 `~/.cache/archify-chrome/sysroot`（libnss3、libatk、libcairo、libfontconfig、Noto CJK 等）；
3. 运行时设置：

```sh
export ARCHIFY_CHROME=~/.cache/archify-chrome/chrome/linux-157.0.8103.38/chrome-linux64/chrome
export ARCHIFY_CHROME_NO_SANDBOX=1          # 容器内无 unprivileged user namespace
export LD_LIBRARY_PATH=~/.cache/archify-chrome/sysroot/usr/lib/x86_64-linux-gnu:~/.cache/archify-chrome/sysroot/lib/x86_64-linux-gnu
export FONTCONFIG_PATH=~/.cache/archify-chrome/sysroot/etc/fonts
export FONTCONFIG_FILE=$FONTCONFIG_PATH/fonts.conf
```

没有 Chrome 时：`validate` / `deliver` / `check` 仍可出 HTML，`browser-check` 会 `skipped`，不得声称通过视觉门禁。

## 6. 生成 / 重新生成视觉产物

```sh
# 全部重新生成（需要 ARCHIFY_CHROME）
bash scripts/archify-visuals.sh

# 单张
node "$ARCHIFY_SKILL/bin/archify.mjs" finalize architecture \
  docs/visuals/src/current-architecture.json \
  docs/visuals/current-architecture.html \
  --quality showcase --json
```

源文件在 `docs/visuals/src/*.json`；输出 HTML 自带交互、主题与导出，不依赖网络。每张图的验收证据在 `docs/visuals/evidence/`。

## 7. 限制

- 当前只有 5 种图：architecture / workflow / sequence / dataflow / lifecycle。ERD / class / tree / timeline / waterfall / 一页解释器需要等 Archify 3.2.0 的 DSH 适配器发布（1.1.0）。
- 1.0.0 的 `includeDefaultRoots: false` 只影响它自己的 provider；preset 的 `skill-filesystem` 仍提供默认根。若未来该 provider 成为唯一 skill 源，需要复查。
- 适配器未在 DSH 0.2.2 官方认证；升级 DSH 后需重跑 `doctor` + 一张图。
- 更新提示：finalize receipt 显示 3.0.1 → 3.2.0 可用；**未自动升级**（按 Skill 规则，需用户明确要求）。

## 8. 回滚

```sh
# 先 disable / 热移除（若已挂载）
plugin_manager set_bundle target=@tt-a1i/archify-dsh enabled=false
# 再卸包
dsh plugin --profile web remove @tt-a1i/archify-dsh
```

恢复 `/tmp/archify-install-backup/` 的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`，重启 DSH。回滚后 skill catalog 中 `archify` 消失；不影响 dsh-bot。

## 9. 安全与许可

- `cordis.patch.yml` 含 `!!js` 表达式（host 进程代码）：只做包路径解析，不发网络、不读凭据、不启进程。
- 适配器无运行时依赖、无遥测、无 install hook；Skill 有可选的稳定版更新检查（只读固定 manifest，不自动安装）。
- 需要时 `ARCHIFY_UPDATE_CHECK_DISABLED=1` 关闭更新检查。
- 保留 `LICENSE` / `NOTICE` / `THIRD_PARTY_NOTICES.md`；1.0.0 内含 3.0.1（MIT），3.2.0 起 Apache-2.0。
