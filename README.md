# Self-Refueling Research Agent

> 推理即燃料。输入一个研究主题，Agent 自动规划、调用 Orbio 网关完成搜索/分析/总结、输出 Markdown 报告；
> 期间自行监控 Orbio API 余额，不足时从 Exchange 订单簿低价买入 CREDIT 并激活，全程无需人工干预。

为 [Orbio](https://www.orbio.so) 生态构建比赛而作。运行在 Robinhood Chain（chain id 4663）。

## 工作流程

```
用户输入主题
      ↓
Agent 核心循环
  ├── 1. 规划任务（便宜模型输出 JSON 计划，不合法则重试一次）
  ├── 2. 执行子任务（联网检索模型 perplexity/sonar，带真实引用）
  ├── 3. 每 2 步一个检查点：读余额（GET /api/v1/key）→ 记账本次 API 花费并对照上限 → 低于阈值则续费
  ├── 4. 续费：exchange.getQuote → 折扣达标 → 预算守卫 → 预检 gas / USDG → approve → buyAndActivate → 等余额更新
  ├── 5. 网关中途报余额耗尽（402）→ 立即续费并重试一次
  └── 6. 强模型汇总，输出报告（含成本表 + 续费记录）；中途失败则保存部分报告 + 日志
```

三层模型路由：规划 `gpt-4o-mini` → 检索 `perplexity/sonar` → 总结 `claude-sonnet-4.5`。任一模型无提供方时自动回退到备选。

## Orbio 集成细节（均来自官方文档）

| 项目 | 实现 |
|---|---|
| API Key | 钱包签名 `Orbio API key · chain 4663 · epoch N` → `sk-orb-N-base64(sig)`，不需要注册接口；轮换 = epoch+1 |
| 推理 | `https://api.orbio.so/api/v1`，OpenAI SDK 直连，模型 ID 为 OpenRouter 风格（`GET /models`）；配置的模型无提供方时自动回退到备选模型 |
| 余额 | `GET /api/v1/key` 的 `balance.available`（美元字符串） |
| 买入 | `exchange.getQuote(usdgIn, maxFills)` 报价 → `buyAndActivate(usdgIn, minCreditOut, bytes32(recipient), maxFills)`；USDG/CREDIT 均 6 位小数 |
| 激活已持有 CREDIT | `credit.previewActivation` + `credit.activate(amount)` |
| 折扣计算 | `price = (usdgSpent + feeAtoms) / creditOut`，`discount = 1 - price`，低于 `MIN_DISCOUNT` 不买 |
| 合约地址 | 默认写死官方部署，见 [src/abi/orbio.ts](src/abi/orbio.ts)，可用 `.env` 覆盖 |

## 文件结构

```
src/
├── index.ts            入口 / CLI（研究、追问、对比、web、积分命令）
├── runtime.ts          构建钱包 / CreditManager / LLM / 报告库（CLI 与 Web 共用）
├── service.ts          研究、追问、对比、状态的高层封装
├── server.ts           Express Web API + SSE 日志流
├── store.ts            报告归档（.md + .json + .log）、追问追加、对比保存
├── config.ts           .env 校验（zod）、常量、配置自洽检查
├── wallet.ts           钱包、签名派生 / 轮换 API Key（只存内存）
├── credit-manager.ts   余额、报价、buyAndActivate、activate
├── budget.ts           单任务 / 每日 USDG 预算守卫（持久化到 .agent-state.json）
├── llm.ts              Orbio 网关封装 + token 计量 + 模型回退
├── research-agent.ts   规划 → 检索 → 综合；追问；对比；检查点（余额 / API 花费上限）；部分结果
├── team.ts             团队模式：工作钱包派生、协调者拨款（串行）、并行研究、汇总降级
├── team-report.ts      团队报告渲染
├── prompts.ts          提示词
├── report.ts           Markdown 报告渲染（含未完成标注）
├── mock.ts             离线演示替身（含 402 模拟）
├── retry.ts / logger.ts  重试；分级日志、SSE 监听、按次运行归档
└── abi/orbio.ts        合约地址 + Exchange / CREDIT ABI
public/index.html       Web 界面（单页）
tests/                  纯逻辑单元测试
```

## 快速开始

### 离线演示（不需要私钥、不联网、不花钱）

```bash
npm install
npm run demo
```

`--mock` 模式用内存里的假余额（起始 = 阈值 + $0.04）、固定 18% 折扣的假订单簿和固定的模型回复，
完整走一遍：规划 → 执行 → 第 2 步后余额低于阈值 → 报价 → 折扣达标 → buyAndActivate（模拟）→ 余额恢复 → 汇总 → 报告写入 `reports/`。
日志与报告里的续费记录展示了自动续费的完整判断链路。

### 真实运行

```bash
cp .env.example .env   # 只需填写 PRIVATE_KEY（RPC 与合约地址已有默认值）
npm run dev -- models
npm run dev -- balance
npm run dev -- quote 5
npm run dev -- "Robinhood Chain 上的 AI 推理积分市场现状"
```

其他命令：

```bash
npm run dev -- list                          # 历史报告
npm run dev -- show <id>                     # 打印某份报告
npm run dev -- ask <id> "追问内容"            # 单次追问（基于报告内容作答）
npm run dev -- chat <id>                     # 交互式多轮追问
npm run dev -- compare <idA> <idB>           # 对比两份报告（共同结论 / 差异 / 数据变化 / 可靠性）
npm run dev -- refuel 0.3                    # 买入并激活（默认 DRY_RUN 只模拟）
npm run dev -- activate 3                    # 激活钱包里已有的 3 CREDIT
npm run dev -- rotate-key                    # 轮换 API Key（epoch+1）
npm run dev -- "<topic>" --live              # 允许真实链上交易
npm test
```

研究完成后 CLI 会自动进入追问模式，输入 `exit` 退出；加 `--no-chat` 跳过。

### Web 界面

```bash
npm run web          # http://localhost:3000，真实模式
npm run web:mock     # 离线演示模式
```

单页界面：输入主题开始研究、实时日志流（SSE）、历史报告列表、报告渲染与下载、追问、勾选两份报告对比。

### 团队模式（协调者 + 多个工作 Agent）

```bash
npm run demo:team                                   # 离线演示
npm run dev -- team wallets                         # 查看派生的工作 Agent 钱包地址
npm run dev -- team "<topic>" --workers 3 --steps 2 # 真实运行
npm run dev -- team fund 1 0.1 --live               # 手动给 1 号 Agent 激活 0.1 USDG 的 CREDIT
npm run dev -- team transfer 1 0.5 --live           # credit.transfer 0.5 未激活 CREDIT 给 1 号 Agent
```

工作原理：

- 协调者用便宜模型把主题拆成 N 个互补子课题，每个工作 Agent 并行研究自己的子课题，协调者用强模型汇总。
- 工作 Agent 的钱包由主私钥确定性派生（`keccak256(主私钥 ‖ 序号)`），不存文件，**不持有 USDG 和 gas**。它们只需签名派生自己的 Orbio API Key。
- 工作 Agent 余额低于 `WORKER_LOW_THRESHOLD` 时向协调者申请；协调者用 `buyAndActivate(..., beneficiary = worker)` 把 CREDIT 直接激活到该 Agent 的 API 余额（若协调者钱包持有未激活 CREDIT，则用 `activate(amount, beneficiary)` 只花 gas）。所有拨款走协调者的折扣策略和预算守卫；预算拒绝时工作 Agent 用剩余余额继续。
- 真实模式下 `DRY_RUN=true` 无法链上拨款，工作 Agent 会共用协调者的 Key 跑通并行流程；`--live` 才会真实给工作 Agent 钱包激活额度。
- 报告包含团队分工表、各 Agent 子报告、协调者拨款记录（beneficiary + 交易哈希）。Web 界面的模式下拉框可选 2 到 4 个 Agent。

### 报告归档

每次运行在 `reports/` 生成三个同名文件：`<id>.md`（可读报告）、`<id>.json`（结构化记录：步骤原始结果、成本、追问历史、状态）和 `<id>.log`（本次运行的完整日志，含每次余额检查、报价、链上交易）。追问答案会追加到 `.md` 末尾的「追问」章节；对比结果保存为 `compare_<时间>.md`。

运行中途失败（预算超限、网关拒绝、网络错误）时同样归档：报告顶部标注「未完成」和原因，保留已完成步骤的原始结果，CLI `list` 和 Web 列表都会标出，日志照常保存，付过费的工作不会丢。

## 预算控制

| 层 | 控制 | 超限行为 |
|---|---|---|
| 链上购买 | `MAX_SPEND_PER_TASK` / `MAX_SPEND_PER_DAY`（USDG，每日额度持久化在 `.agent-state.json`） | 拒绝本次购买；Agent 用剩余余额继续，余额耗尽则出部分报告 |
| 网关消耗 | `MAX_API_SPEND_PER_TASK`（美元，每个 Agent 每次运行） | 停止研究，保存部分报告 |
| 价格 | 折扣 ≥ `MIN_DISCOUNT` 才买；`minCreditOut` 为报价的 99% 防滑点；只授权本次 `usdgIn` | 折扣不达标则不买 |
| 团队拨款 | 协调者的预算守卫统一管所有工作 Agent 的拨款，拨款请求串行执行 | 被拒的 Agent 用剩余余额继续 |

启动时检查配置是否自洽（例如续费金额大于单任务上限、工作 Agent 数乘以拨款额超过上限），有问题打印警告。`balance` 命令和 Web 头部显示今日已花 / 上限。

## 日志

- 分级（debug / info / warn / error）、分模块（credit / budget / agent / team / …），团队模式每行带 Agent 标签。
- Web 界面通过 SSE 实时推送；每次运行的完整日志归档为 `reports/<id>.log`，报告页有「查看日志」链接。
- 所有链上操作（报价、approve、buyAndActivate、activate、拨款）连同交易哈希都进日志和报告。

## 错误处理

- 网络 / 链上 / 模型调用最多重试 3 次（指数退避）；gas 不足、余额不足、合约 revert、模型无提供方这类重试也不会好的错误直接终止，不重试。
- 配置的模型没有提供方（404）时自动切换到备选模型。
- 网关在两次余额检查之间报余额耗尽（402）：立刻续费并重试一次，续费被预算拒绝则保存部分报告。
- 发交易前预检 gas 和 USDG / CREDIT 余额，不够时给出「持有多少、需要多少、打到哪个地址」的提示；Exchange 的 `InsufficientFunds()` 自定义错误已加入 ABI，回滚原因可直接解码（主网实测 approve 57,964 gas、buyAndActivate 174,876 gas，一次续费约 0.000016 ETH）。
- 规划 / 拆题的 JSON 不合法时让模型重试一次。
- 团队模式：单个工作 Agent 失败不影响其他 Agent，其已完成步骤保留进报告；协调者汇总失败时降级为拼接各 Agent 子报告。
- 钱包首次激活前网关返回 401，按余额 $0 处理并继续购买流程。
- `DRY_RUN=true`（默认）只报价，不发交易；CLI 出错只打印一行原因，`LOG_LEVEL=debug` 才打印堆栈。

## 主网验证记录

2026-09-19 起在 Robinhood Chain 主网用 1 USDG 完整跑通自动续费链路，之后每个功能都在主网真实验证：

| 项目 | 值 |
|---|---|
| Agent 钱包 | `0x7e0831BC91aabDce79dfdd8d2d548dA37561c1FD` |
| 报价 | 1 USDG → 1.3072 CREDIT，1 笔成交，手续费 0.0196，折扣 23.5% |
| approve | `0xee961563a3af01060f278cb21fbd533cd2a02d186817b1cd6af5b58078123515` |
| buyAndActivate | `0xef4d783b4c3bb2142c779bd609facdd33ad991e6a8d704ff72162537893c4e65`（block 67212210，activationId 250） |
| 网关余额 | `$0.0000 → $1.3072`，随后 `GET /api/v1/key` 正常返回 |
| 真实研究运行 | 3 步 + 总结共 5 次调用（规划 gpt-4o-mini / 检索 perplexity/sonar / 总结 claude-sonnet-4.5），12294 tokens，花费 `$0.0702`（`$1.2703 → $1.2001`），报告来源为真实网址 |
| 追问 | 对报告追问「现在加密货币是牛市吗」，模型如实回答「报告未涉及」并给出可追加的研究步骤，未编造 |
| 报告对比 | 对比同一主题 17:12 与 18:32 两份报告：列出 5 条共同结论、4 处表述差异、11 项指标的数据变化表，并指出 DEX 交易量口径不一致，花费约 `$0.03` |
| Web 界面 | 真实模式下从网页发起研究「现在加密货币是牛市了吗」，SSE 日志实时推送，61 秒完成，花费 `$0.0563`；网页端对比两份报告正常 |
| 团队模式（DRY RUN） | 工作 Agent 共用协调者 Key：协调者拆 3 个子课题，3 个 Agent 并行各 2 步，87 秒完成，14 次调用，花费 `$0.0712` |
| 链上拨款给工作 Agent | `team fund 1 0.1 --live`：0.1 USDG → 0.1265 CREDIT（1 笔成交，手续费 0.0020，折扣 20.9%），`buyAndActivate(beneficiary = 1 号 Agent 钱包)` 上链 `0x019f554711649d1e3b7950fb50ada4e3e3b71a0a4df02b1f51fa1e7af4e7b689`（block 67698060，activationId 314），1 号 Agent 的网关余额 `$0.0000 → $0.1265`。工作 Agent 钱包全程没有 gas 和 USDG。首次尝试因协调者钱包 USDG 为 0 回滚 `InsufficientFunds()`（approve `0xbe764a…` 已上链），据此加入了发交易前的余额预检 |
| 团队模式（真实链上） | `team "…" --workers 2 --steps 2 --live`：1 号 Agent 已有余额直接开工；2 号 Agent 余额 $0 低于阈值 → 协调者自动 approve `0x4b4a4e64d67c47c0f7cc34a92dc77924c9573d05b22dad1fb15b388c6b4d60dd` + buyAndActivate `0xf5aabd9ea07271db322d5387d679e8b352e47375753b7988f971e9d6b5efac85`（block 67698350）→ 2 号余额 `$0.0000 → $0.1265`。10 次调用、88 秒、链上花费 0.1 USDG、网关花费约 `$0.06`（协调者 $0.0464 + 工作 Agent $0.0162），报告含真实来源与拨款记录表 |
| 检查点记账与日志归档 | 研究「Robinhood Chain 上 CREDIT 订单簿的折扣水平与流动性」3 步：两个检查点记录本次 API 花费 `$0.0070 → $0.0110`（上限 $0.5），56 秒，5 次调用，花费 `$0.0588`；报告对查不到的数据如实写「未找到公开资料」，来源为 Bitquery / Matrixport / MEXC Learn 等真实网址；同名 `.log` 归档了全过程 |

注意：钱包在首次激活前，网关对签名派生的 Key 返回 401；代码把这种情况按余额 $0 处理并继续购买流程。

离线演示模式下额外验证的故障场景（不花钱，可自行复现）：

| 场景 | 命令 | 结果 |
|---|---|---|
| 网关中途报余额耗尽 | `$env:CREDIT_LOW_THRESHOLD='0'; npm run demo` | 第 2 步收到 402 → 立即续费 0.3 USDG → 重试成功 → 报告完整生成 |
| 网关花费超上限 | `$env:MAX_API_SPEND_PER_TASK='0.05'; npm run demo` | 第 4 步后停止，保存标注「未完成」的部分报告（含 4 步原始结果）和日志，进程以错误退出 |

## 路线图

- [x] MVP：规划 → 执行 → 自动续费 → 报告 → 预算控制
- [x] 多模型路由（规划 / 联网检索 / 总结）
- [x] 历史报告存档与对比
- [x] 多轮追问（CLI 与 Web）
- [x] Web 界面
- [x] 多 Agent 协作（协调者向工作 Agent 按需激活额度，工作 Agent 无需 gas）—— 主网已验证
- [x] 协调者向工作 Agent `credit.transfer` 未激活 CREDIT（`team transfer` 命令，尚未链上实测）
- [ ] 多余 CREDIT 自动 `sell` 挂单（不在本次范围）
- [ ] Uniswap Universal Router 路径（USDG → NVDA → ORBIO → CREDIT）作为订单簿之外的备选（不在本次范围）
- [ ] Telegram / Discord Bot（不在本次范围）
