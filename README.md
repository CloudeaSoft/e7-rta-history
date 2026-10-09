# e7-rta

使用 Node.js 与 GitHub Actions，每天 UTC+8 **22:00** POST 拉取 Epic Seven RTA 战斗记录，先保存原始响应快照，再扫描全部快照并重建去重总记录，最后把本次数据变动合为一个 commit 推送到默认分支。

参考项目：[CloudeaSoft/warframe-weekly-rivens-archive](https://github.com/CloudeaSoft/warframe-weekly-rivens-archive)。采用其定时抓取、数据入库和机器人提交的结构；这里使用零第三方依赖的 Node.js 脚本。

## 数据源

```text
POST https://e7api.onstove.com/gameApi/getBattleList?nick_no=199070445&world_code=world_asia&lang=en
```

请求保留 URL 查询参数，空请求体，无需 Token 或 Cookie。归档对象固定为亚服玩家 `199070445`。抓取阶段先保存 HTTP 成功响应体；重建阶段要求 `code === 0` 且 `value.result_body.battle_list` 为数组，并核对账号与区服。

## 数据布局

```text
data/
  snapshots/YYYY-MM-DD/<UTC时间戳>-<UUID>.json  # 完整原始响应体
  snapshots/2026-09-28/rta-26.09.28.txt         # 原样导入的历史响应
  battles.json                                # 从全部快照生成的 JSON 数组
scripts/
  archive.mjs                                 # 请求、校验、去重、归档
  fetch-battles.mjs                            # 只拉取并保存快照
  rebuild-battles.mjs                          # 只从本地快照重建总记录
```

- 每次成功抓取都保存独立快照，包括没有新战斗的运行；文件名使用 UTC 时间和 UUID，同一天手动执行多次也不会覆盖。
- 快照保存 HTTP 响应体字节，不重新格式化 JSON；`.gitattributes` 禁止 Git 对快照进行换行转换。HTTP 传输压缩由 fetch 自动解压，不保存响应头。
- 快照是唯一数据源。重建递归读取 `data/snapshots/` 下的 `.json` 和 `.txt`，按相对路径的字典序处理（路径使用 `YYYY-MM-DD` 日期），同一个快照内保留 API 列表顺序。不要将说明文件放进快照目录。
- 总记录保留每条战斗的全部原始字段。去重键为 `worldCode + nicknameno + season_code + battle_seq`，战斗编号的数字与字符串形式视为同一编号。
- 同一战斗保留路径排序最早的快照中的内容，其他版本仍保存在原始快照里。补入更早的快照可能改变记录内容或排列；总记录并非按对战时间排序。同一时间戳的文件按完整文件名排序，确保结果可复现。
- `data/battles.json` 是派生文件，重建不读取其旧内容，即使它丢失或损坏也能恢复。重复重建产生完全相同的字节；删除或修改源快照会反映在下次重建结果中。
- 当前数据量很小，采用全量重建，不维护增量缓存。每次命令输出快照数、读取记录数、重复数和唯一记录数，GitHub Actions 日志保留运行结果。
- 请求超时为每次 30 秒，网络错误、429 和 5xx 最多尝试三次；其他 HTTP 错误直接失败。HTTP 成功响应先原样落盘，不因解析失败删除快照。非 2xx 响应不作为快照保存。
- 重建遇到 API 业务错误、无效 JSON、缺失身份字段或错误账号时，报告快照路径并失败；保留原始快照和旧总记录，不提交这次数据变动。Actions 失败时上传快照为诊断 artifact，保留 14 天。排查后将无效快照移出 `data/snapshots/`，再重建；不要为绕过错误而清空总记录。
- 所有快照校验成功后，总记录使用临时文件后原子替换。快照目录缺失或没有快照时拒绝覆盖总记录；合法的空列表快照可以生成空总记录。GitHub Actions 将运行串行化；本地请勿并发运行抓取或重建。

## 本地使用

需要 Node.js 24 或更新版本，无需安装依赖。

```sh
npm test
npm run archive
```

`npm run archive` 顺序执行以下两步，也可以分别运行：

```sh
npm run fetch    # 网络 POST，只保存原始快照
npm run rebuild  # 无需网络，从全部本地快照重建总记录
```

补录历史数据时，将完整接口响应原样放入 `data/snapshots/YYYY-MM-DD/`，扩展名使用 `.json` 或 `.txt`，然后执行 `npm run rebuild`。目录日期应为快照获取日期；只有日期而没有准确时间的导入文件可以保留原文件名。已导入 `rta-26.09.28.txt`，日期来自文件名，内容字节未作修改。

本地命令只写数据，不自动提交。如需提交：

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
