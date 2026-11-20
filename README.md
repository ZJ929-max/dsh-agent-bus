# agent-bus

让**同一个 DSH profile 里不同的会话互相留言**：A 发一句给 B，B 在下一次模型步看到并回一条，A 再看到回复。本机进程内，不是远程主机。

两个工具（加载时注册一次，不按条件增删）：

| 工具 | 作用 |
|---|---|
| `agent_bus_post(to, text)` | 送一条消息进另一个**存活会话**的下一次模型步（running → `agent.inject`，idle → `agent.followup`）；同一对会话连续自动往返上限 3 次，超出暂停 10 分钟后自愈，人类发话立即重置 |
| `agent_bus_inbox()` | 列出可投递的存活会话（**会话标题** + 4 字符标记）、本会话的标题与标记、以及收到的留言 |
| `agent_bus_status(peer?, limit?)` | 看别人的状态：标题、running/idle、第几轮/该轮是否还在跑、最后一次活动距今多久、上下文占用百分比、你与它这一轮还能不能再发；给 `peer` 时输出单个会话的详情（含它最后一句和它发给你的最近几条） |

机制、边界、防对喷规则见 [docs/DETAIL.md](docs/DETAIL.md)；实测记录见仓库外的 `agent-bus-selftest.md`。

## 两条预算（都可调，都是常量）

- **对话**：同一对会话连续自动往返上限 3 次（10 分钟内），超出暂停、10 分钟后自愈，人类在任一边说一句立即清零。
- **扇出**：一个会话 10 分钟内最多触及 12 个不同会话、最多投递 24 次——免得一次唤醒整个 profile（每唤醒一个会话就是一轮真实模型请求）。

## 与 dsh-tokeneconomizer 的关系：不合并，只共享约定

2026-11-20 就「能不能和 [dsh-tokeneconomizer](https://github.com/ZJ929-max/tokeneconomizer-dsh) 合并成一个插件」做过一次跨会话评审（对方是读过 TokenEconomizer 完整交接记录的会话）。结论是**不合并**，理由摘三条：

1. **工具表就是成本**：两个包合并不会让工具变少，只会让每个会话的固定前缀变大；工具一变，所有会话的提示词前缀缓存全废。一个「省 token」的插件为了看起来完整去扩前缀，是最讽刺的自我否定（TokenEconomizer 0.2.0 正在往单工具 6 action 收敛）。
2. **信任级别不同**：TokenEconomizer 是只读观察 + 建议；本插件能往别的会话的上下文里注入 `user` 消息，是高权限。合进一个包会给所有装 TE 的人附赠一条跨会话注入通道，而且审计时看不出这是两个信任级别。
3. **许可与发布节奏**：TokenEconomizer 是 MPL-2.0 的公开仓库（文件级 copyleft、有 release 与论文机制移植的归属说明）；本包是本机私有、未声明许可。同仓就得拆目录、拆 LICENSE、拆 tag——那已经等价于不合并。

### 共享的三条约定（不共享运行时）

1. 任何进入上下文的东西都带**来源标记 + 不可信标签**（本插件：`[agent-bus] … UNTRUSTED DATA` 与 `--- begin/end verbatim message ---`）。
2. 每次注入、每次止损都落一条**可审计记录**，并且能被工具查出来（本插件：`user/message` 的 `source.kind='agent-bus'` + `~/.dsh/agent-bus/inbox-<sessionId>.json` + `agent_bus_inbox`）。
3. 阈值必须**有上限、可关、可解释**（本插件：`MAX_AUTO_HOPS=1`、`MAX_TEXT=4000`、`MAX_RECORDS=200`，全部写在 docs 里并出现在 `agent_bus_post` 的返回值与拒绝理由中）。

## 安装

```powershell
plugin_manager install_bundle target="<这个目录的绝对路径>"
```

不要手改 profile 的 `package.json` / `cordis.patch.yml`。

## 许可

**MPL-2.0**，全文见 [LICENSE](LICENSE)；`index.js` 顶部带标准 MPL 头部。
插件由 AI 在 DeepSeek Harness 里写成、由人类定红线并复核，披露见 [AI-DISCLOSURE.md](AI-DISCLOSURE.md)。

本包是「DSH 插件整合包」的成员之一：整合包只做**元包 + 索引**（一次装齐 / 按需单装），
每个插件保持独立包、独立仓库、独立版本，代码不合并。

仓库：<https://github.com/ZJ929-max/dsh-agent-bus>（索引 <https://github.com/ZJ929-max/dsh-plugins> 按 commit 钉住版本）。
