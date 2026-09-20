# Screenshots / 截图

Terminal and browser screenshots taken while building and verifying the agent on Robinhood Chain mainnet (2026-09-19 → 2026-09-20). The first log line of every run states its mode: `(LIVE)` = real transactions, `(DRY RUN)` = real gateway but no transactions, `(MOCK)` = offline demo.

开发和主网验证期间（2026-09-19 → 2026-09-20）的终端与浏览器截图。每次运行的首行日志标明模式：`(LIVE)` 真实交易，`(DRY RUN)` 真实网关但不发交易，`(MOCK)` 离线演示。

| File | Shows / 内容 |
|---|---|
| `01-cli-research-run.png` | Real research run with checkpoints · 真实研究运行与检查点 |
| `02-report-cost-and-followup.png` | Report cost table + interactive follow-up · 成本表与追问 |
| `03-cli-compare.png` | `compare` of two reports · 报告对比 |
| `04-web-ui-report.png` | Web UI report view · Web 界面报告页 |
| `05-web-ui-compare.png` | Web UI comparison tab · Web 界面对比页 |
| `06-team-demo-mock.png` | `demo:team`, coordinator funds 3 workers (**mock**) · 团队离线演示（**模拟**） |
| `07-mainnet-worker-funding.png` | **Mainnet**: `team fund --live` + live team run auto-funding worker 2 · **主网**拨款 |
| `08-mainnet-team-report.png` | Live team report with real sources · 真实团队报告 |
| `09-mainnet-team-cost-and-balance.png` | Live team cost table, funding tx hash, wallet balance · 成本表、拨款哈希、钱包余额 |
| `10-checkpoint-api-spend.png` | Checkpoint API-spend accounting vs cap · 检查点记账 |
| `11-typecheck-test-build.png` | typecheck / 11 tests / build all green · 类型检查、测试、构建 |
| `12-preflight-insufficient-funds.png` | The `InsufficientFunds()` revert that led to the pre-flight checks · 催生预检的回滚 |

Full descriptions, transaction hashes and blocks: [SUBMISSION.md](../../SUBMISSION.md). 完整说明与交易哈希见 [SUBMISSION.md](../../SUBMISSION.md)。
