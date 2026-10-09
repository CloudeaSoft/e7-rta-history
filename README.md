# e7-rta

使用 Node.js 与 GitHub Actions，每天 UTC+8 **22:00** POST 拉取 Epic Seven RTA 战斗记录，保存原始响应，提取未收录的战斗并追加到总记录文件，再把本次数据变动合为一个 commit 推送到默认分支。

参考项目：[CloudeaSoft/warframe-weekly-rivens-archive](https://github.com/CloudeaSoft/warframe-weekly-rivens-archive)。采用其定时抓取、数据入库和机器人提交的结构；这里使用零第三方依赖的 Node.js 脚本。

## 数据源

```text
POST https://e7api.onstove.com/gameApi/getBattleList?nick_no=199070445&world_code=world_asia&lang=en
```

请求保留 URL 查询参数，空请求体，无需 Token 或 Cookie。归档对象固定为亚服玩家 `199070445`。只接收 `code === 0` 且 `value.result_body.battle_list` 为数组的响应，并核对账号与区服。

## 数据布局

```text
data/
  snapshots/YYYY-MM-DD/<UTC时间戳>-<UUID>.json  # 完整原始响应体
  battles.json                                # 全部已收录战斗，JSON 数组
scripts/
  archive.mjs                                 # 请求、校验、去重、归档
  fetch-battles.mjs                            # 命令行入口
```

- 每次成功抓取都保存独立快照，包括没有新战斗的运行；文件名使用 UTC 时间和 UUID，同一天手动执行多次也不会覆盖。
- 快照保存 HTTP 响应体字节，不重新格式化 JSON；`.gitattributes` 禁止 Git 对快照进行换行转换。HTTP 传输压缩由 fetch 自动解压，不保存响应头。
- 总记录保留每条战斗的全部原始字段，按首次发现顺序追加。去重键为 `worldCode + nicknameno + season_code + battle_seq`，战斗编号的数字与字符串形式视为同一编号。
- 同一战斗后续发生字段变化时，总记录保留首次收录内容，后续内容仍在对应快照中。总记录并非按对战时间排序。
- 请求超时为每次 30 秒，网络错误、429 和 5xx 最多尝试三次；其他 HTTP 错误直接失败。API 业务错误、无效 JSON、缺失身份字段、错误账号或已有总记录损坏时失败，不清空总记录，也不提交错误数据。
- 总记录使用临时文件后原子替换。GitHub Actions 将运行串行化；本地请勿同时运行多个抓取进程。

## 本地使用

需要 Node.js 24 或更新版本，无需安装依赖。

```sh
npm test
npm run fetch
```

本地抓取只写数据，不自动提交。如需提交：

```sh
git add data
git commit -m "chore(data): archive E7 RTA battles"
```

## 启用 GitHub Actions

1. 在 GitHub 建立空仓库，将本地仓库推送到 `main`：

   ```sh
   git remote add origin https://github.com/<owner>/e7-rta.git
   git push -u origin main
   ```

2. 确保仓库允许运行 Actions，且默认分支允许 `GITHUB_TOKEN` 写入。工作流声明了 `contents: write`；如果组织策略或分支保护禁止机器人直接推送，需要调整相应权限。
3. 在 **Actions → Archive E7 RTA battles → Run workflow** 手动执行一次，确认远端能够访问 API 并提交数据。

定时表达式为 `0 14 * * *`，即 UTC 14:00 / Asia/Singapore 22:00，与北京时间相同。支持 `workflow_dispatch` 手动触发，始终归档到仓库默认分支。每次运行只有一个数据 commit（没有新记录时该 commit 仅新增快照）。

GitHub 定时任务不是精确定时器，负载高时可能延迟或丢弃运行；工作流必须存在于默认分支。公开仓库长时间没有活动时，定时工作流也可能被自动停用。见 [GitHub schedule 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

## 覆盖范围

2026-10-09 实测该接口返回 `total_count: 100` 和 100 条战斗记录。本项目仅归档指定请求实际返回的数据，不假设存在分页接口，也不能补回接口不再返回的历史战斗。若两次抓取之间的新增记录超出接口可见范围，可能漏记；归档不保证完整历史覆盖。接口中的时间字段原样保留，不推断它们的时区。
