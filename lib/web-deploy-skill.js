// dsh-remote — built-in agent skill for remote DSH deployment (issue #46, P3).
//
// Layer 1 (`lib/web-deploy.js`) handles the deterministic path: probe the
// remote, install to a private prefix, verify, attach. This module is the
// ESCAPE HATCH for everything that path cannot express — a missing package
// manager, a proxy, sudo-only systems, an internal mirror, a Windows remote, or
// a failure whose message does not match any known signature.
//
// It is a skill rather than more code because the value here is JUDGEMENT over
// arbitrary output, and because there is no closed set of remote environments to
// enumerate. The skill body is therefore written as a diagnosis-first playbook:
// the symptoms actually measured while building issue #46 come first, because
// those are the ones that waste the most time.
//
// Two deliberate properties:
//
//  1. **The skill is registered at runtime, not shipped as a file.** The plugin
//     is a single npm package; a filesystem skill would need a writable
//     `$DSH_HOME/skills` and would collide with whatever the user keeps there.
//     `ctx.skills.register()` keeps it self-contained and namespaced.
//  2. **It is user-invocable and model-invocable.** The settings button starts a
//     session that already has the skill selected; the model may also reach for
//     it on its own when an `rw_*` call fails with a deployment-shaped error.
import { DEFAULT_INSTALL_VERSION, DEFAULT_PREFIX_SUFFIX } from './web-deploy.js'

/** Stable skill name; kebab-case is required by the registry. */
export const SKILL_NAME = 'dsh-remote-deploy'

/**
 * The skill body.
 *
 * Written for an agent that already has this plugin's `rw_*` tools. It is
 * intentionally explicit about the two failure signatures measured on a real
 * host, because a generic "install it" instruction would have been useless for
 * both of them.
 */
export const SKILL_BODY = `# 在远端机器部署并验证 DSH

用途：用户想连一台机器的 DSH 网页界面（\`dsh web\`），但连不上。你负责把环境修好并**证明**
它真的能用。确定性流程（探测/私有前缀安装/校验）已经由插件的「部署并验证」按钮实现；
你只在它做不到或失败时才被叫来。

## 先用工具，不要一上来就手工

**第一件事：调 \`rw_deploy_probe\`。** 它是只读的，给出结构化体检：平台/架构、node/npm、
现有 dsh 及版本、**原生模块能否启动**、是否认识 \`--no-open\`、Git Bash、代理与 npm 源、
安装前缀可写性，以及判定结论（blocker/warn/info）与修复建议。先读它的结论，不要自己拼命令猜。

它**只读、不安装**（刻意的）。要装就用设置页的「部署并验证」卡片——它装到私有前缀并逐步校验。
你在这里的价值是处理那条路径覆盖不到的情况（见下文的长尾）。真需要自己安装时照本文流程做，
并在结论里说明为什么自动路径不适用。

## 两个已实测的失败签名（最重要）

### 1. \`Failed to load native module: pty.node\`

**根因**：dsh 依赖 node-pty，而某些版本发布的包里**没有当前平台的预编译产物**。
实测：\`node-pty@1.1.0\`（dsh 0.1.0-rc.6 依赖它）只带 darwin/win32 的 prebuild，
**没有 linux-x64**，所以 \`dsh web\` 在 Linux 上**根本起不来**。
\`node-pty@1.2.0-beta.15\`（dsh 0.1.5-rc.2 起）带 Linux 产物。

**判断**：\`ls <dsh根>/node_modules/node-pty/prebuilds/\` —— 少了 \`linux-x64\` 就是这个病。
**修复**：装 \`@deepseek-ai/dsh@${DEFAULT_INSTALL_VERSION}\` 或更新到私有前缀（见下）。

### 2. \`error: unknown option '--no-open'\`

**根因**：\`--no-open\` 是较新版本的 flag；老版本（实测 0.1.0-rc.6）不认识它，直接退出。
**修复**：插件会自动去掉该 flag 重试一次，通常**不需要你处理**。只有当你手工拼命令时才注意。

### 不是部署问题的报错（别修错方向）

- \`NO_ADAPTER: no adapter registered for provider ...\` / \`no API key for provider route\`
  ⇒ 是**宿主模型/provider 配置**问题，与远端部署无关。
- \`NO_COOKIE\` / 401 ⇒ 登录态问题。
- \`QUOTA\` / \`Insufficient Balance\` ⇒ 额度问题。

## 标准部署流程（私有前缀，绝不污染用户环境）

**原则**：默认**不要** \`npm i -g\`。全局安装需要系统目录写权限、改用户 PATH、
还可能覆盖用户正在用的版本。用私有前缀：

\`\`\`bash
PREFIX="$HOME/${DEFAULT_PREFIX_SUFFIX}"
mkdir -p "$PREFIX"
printf '%s\\n' '{"name":"dsh-remote-install","private":true,"version":"0.0.0"}' > "$PREFIX/package.json"
cd "$PREFIX" && npm install --prefix "$PREFIX" --no-audit --no-fund \\
  '@deepseek-ai/dsh@${DEFAULT_INSTALL_VERSION}'
"$PREFIX/node_modules/.bin/dsh" --version
\`\`\`

（写一个私有 \`package.json\` 是为了防止 npm 向上找到无关项目、改掉它的依赖树。）

**校验**（三步都要过，缺一步不算成功）：
\`\`\`bash
BIN="$PREFIX/node_modules/.bin/dsh"
test -x "$BIN" && "$BIN" --version                      # 1. 二进制存在
ls "$PREFIX/node_modules/node-pty/prebuilds/"            # 2. 有当前平台产物
"$BIN" web --help | grep -q -- '--port'                  # 3. web 子命令在
\`\`\`

⚠️ **常见误判**：\`.bin/dsh\` 是符号链接。\`realpath\` 后 \`dirname(dirname(...))\` 会落在
\`<prefix>/node_modules/@deepseek-ai/dsh\`（包**内部**），那里**没有**兄弟 \`node-pty\`，
于是好安装被判成「缺 pty」。正确做法是**向上找到第一个含 \`node_modules\` 目录的祖先**。

**最后必须端到端证明**（否则「装好了」没有意义）：
\`\`\`bash
# 起一个只监听 127.0.0.1 的 web，抓到它打印的 token 行
DSH_HOME=/tmp/dshweb-check setsid nohup "$BIN" --profile web --port 0 --no-open \\
  >/tmp/dshweb-check.log 2>&1 </dev/null &
sleep 8; grep -m1 'dsh web:' /tmp/dshweb-check.log
\`\`\`
拿到 \`http://127.0.0.1:<port>/?token=…\` 即成功。**用完要清理**（kill 掉并删 log）。

## 长尾情况

- **没有 node/npm**：先装 Node（nvm 最不侵入）。装不了就问用户要权限。
- **公司内网/镜像源**：用 \`npm install --registry <url>\`，或让用户指路。**不要**擅自改
  用户全局 npm 配置。
- **Windows 远端**：启动命令是 POSIX shell（依赖 \`setsid\`/\`nohup\`）。远端有 Git Bash
  时可工作（插件会经 \`bash -s\` 执行）；没有则如实说明暂不支持，不要硬试。
- **代理**：\`HTTP_PROXY\`/\`HTTPS_PROXY\` 对 npm 生效；先探测是否需要。
- **需要 sudo**：**停下来问用户**，不要自作主张提权。

## 纪律

1. **只读优先**：先诊断，再动手。诊断阶段不要写任何东西。
2. **不改用户环境**：不 \`npm i -g\`（除非用户明确要求）、不改 PATH、不动 \`~/.dsh\`。
3. **可回退**：安装只落在私有前缀，删掉那个目录就完全恢复。告诉用户路径。
4. **收尾清理**：你起的进程、写的临时 log、用的临时 DSH_HOME 都要清掉。
5. **报结论要带证据**：贴出关键命令的实际输出，不要只说「已修复」。
6. **不确定就问**：涉及提权、改全局配置、删文件时先确认。
`

/**
 * The skill definition, as data.
 *
 * Split out from registration so the same definition can be filed into the
 * scope of one session (lib/skill-visibility.js) or registered globally as the
 * fallback for a composition with no `agents` service.
 *
 * @returns {object} a fresh skill definition object.
 */
export function deploySkillDefinition() {
  return {
    name: SKILL_NAME,
    description: '在远端机器部署并验证 DSH 网页界面：诊断「连不上」的原因、'
      + '装到私有前缀、校验原生模块与 web 子命令，并端到端证明可用。'
      + '当远端 dsh 缺失、版本过旧、或 dsh web 起不来时使用。',
    whenToUse: '远端 DSH 界面连不上；远端没有 dsh 或版本过旧；'
      + '出现 Failed to load native module: pty.node；需要判断是部署问题还是宿主问题。',
    content: SKILL_BODY,
    source: 'dsh-remote',
    // Both entry points are wanted: the settings button starts a session with
    // it pre-selected, and the model may reach for it when an rw_* call fails
    // in a deployment-shaped way.
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

/**
 * Register the deployment skill globally with the session skill registry.
 *
 * This is the fallback for a composition that cannot gate per session (no
 * `agents` service); see lib/skill-visibility.js for the normal path.
 *
 * Optional by design: a composition without `ctx.skills` simply has no skill,
 * and the deterministic deploy path keeps working. Failures are contained —
 * a skill that fails to register must never take down the plugin.
 *
 * @param {object} ctx - plugin context.
 * @returns {boolean} whether the skill was registered.
 */
export function registerDeploySkill(ctx) {
  try {
    const skills = ctx.get('skills')
    if (!skills || typeof skills.register !== 'function') return false
    skills.register(deploySkillDefinition())
    return true
  } catch (err) {
    // A missing skill only costs the AI fallback; never break the plugin.
    try { ctx.logger?.warn?.(new Error('dsh-remote: deploy skill not registered: ' + String((err && err.message) || err))) } catch { /* no logger */ }
    return false
  }
}

/**
 * Build the prompt handed to the AI when the user asks it to investigate.
 *
 * The failure context is included verbatim because the whole point is that the
 * deterministic path could not classify it — paraphrasing would throw away the
 * only evidence there is.
 *
 * @param {object} context - what the deterministic path learned.
 * @returns {string} the prompt text.
 */
export function buildInvestigatePrompt(context = {}) {
  const c = context || {}
  const lines = [
    `请用 ${SKILL_NAME} 技能，帮我修好这台远端机器的 DSH 网页界面问题。`,
    '',
    `远端：${c.host || '(未知主机)'}${c.user ? ' (' + c.user + ')' : ''}`,
  ]
  if (c.prefix) lines.push(`建议安装位置：${c.prefix}`)
  if (c.findings && c.findings.length) {
    lines.push('', '自动体检已发现：')
    for (const f of c.findings) {
      lines.push(`- [${f.severity}] ${f.summary}${f.detail ? ' —— ' + f.detail : ''}`)
    }
  }
  if (c.error) lines.push('', '自动部署/连接失败信息：', '```', String(c.error).slice(0, 2000), '```')
  if (c.facts && Object.keys(c.facts).length) {
    lines.push('', '体检原始事实：', '```json', JSON.stringify(c.facts, null, 2).slice(0, 2000), '```')
  }
  lines.push(
    '',
    '要求：先诊断、只读优先；装到私有前缀而不是全局；装完要**端到端证明**能起 web',
    '（拿到 `dsh web: http://127.0.0.1:<port>/?token=…`）；收尾清理你起的进程和临时文件；',
    '最后用证据说明结论。涉及提权或改全局配置时先问我。',
  )
  return lines.join('\n')
}
