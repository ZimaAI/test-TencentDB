# mini-SWE-agent

`agentSource: mini-swe-agent`，使用 OpenAI Chat Completions：

```text
POST http://127.0.0.1:8096/mini-swe-agent/default/v1/chat/completions
POST http://127.0.0.1:8096/mini-swe-agent/default/chat/completions
```

请求体沿用 `model`、`messages`、`tools`、`stream` 等标准字段，支持流式和非流式响应。
`default` 是实例 ID；使用 MemoryPanel 的业务用户 Key 鉴权。上游模型配置沿用现有代理，
也可通过 `upstream.agents.mini-swe-agent` 配置该客户端的模型服务。

## 请求头

| 请求头 | 用途 |
| --- | --- |
| `Authorization: Bearer <user_key>` | 现有业务用户鉴权 |
| `x-conversation-id` | 必填，每个评测实例/运行使用独立 ID，同一任务各轮保持一致 |
| `x-tdai-knowledge: enabled` 或 `disabled` | 显式知识库开关，默认 `disabled` |
| `x-team-id`、`x-agent-id` | 启用知识库时必填；校验当前用户可见的团队和自己拥有的 Agent |
| `x-tdai-knowledge-url` | 可选，覆盖注入给 shell 的知识服务地址（包含 `/v3`）；代理不会请求这个地址 |

启用后读取该 Agent 绑定且当前用户可见的 wiki / code-graph，复用现有
`<knowledge_tools>` 提示和 `tools/list` → `tools/call` 只读接口。mini-SWE-agent 用原有
`bash` 工具运行提示中的 curl 命令，无需添加 LLM 工具类型，也不弹出交互式选择表单。
知识库内容仍由模型按需查询，不会把整个知识库放入提示。

两组都不注入团队记忆、技能或 Agent/Task 提示，不执行 L0/技能提取或会话参与写入；
保留既有鉴权、模型路由、计费和可观测性。知识库关闭时不读取知识库、身份绑定或用户资产设置，
原始 messages 和 bash 工具定义透传。开启后再关闭也不会复用注入缓存。

响应头 `x-tdai-knowledge` 和 `x-tdai-knowledge-count` 分别记录模式和注入资源数量。
启用但缺少绑定/就绪资源返回 409，用户身份不匹配返回 403，依赖不可用或服务端未开启知识库返回 503，
格式错误返回 400。失败时不转发到 LLM，避免把失败接入计为知识库实验。

## Docker Desktop

宿主机上的 mini 客户端使用 `http://127.0.0.1:8096`。SWE-bench 的 bash 在独立容器内执行，
通常应设置 `x-tdai-knowledge-url: http://host.docker.internal:8424/v3`。
默认资源地址 `http://memory-hub:8424/v3` 仅适用于加入部署 Compose 网络的容器。
远程 Docker/Modal/Singularity 等环境应改为该环境实际可达的知识服务地址。

无需向评测容器提供代理用户 Key 或知识服务管理 Key；知识服务现有 `tools/list`、`tools/call`
只读端点使用提示中的租户请求头。先从评测容器验证地址可达，再运行正式评测。

在 MemoryPanel 创建或选择业务用户 Agent，为它绑定知识库并等待资源可用。
mini-swe-agent 仓库提供 `model_class: tencentdb` 和 `tencentdb.yaml` 配置覆盖文件；
对照实验使用同一模型/参数/数据集，只切换 `model.knowledge_enabled`，分别保存输出目录。
