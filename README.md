# umini

基于 Node.js + Express 的 AI 聊天后端，使用 DeepSeek API（OpenAI 兼容格式）。

## 前置条件

需先安装 [Node.js](https://nodejs.org/)（建议 LTS），安装后终端中可用 `node -v` 和 `npm -v` 验证。

## 快速开始

```bash
# 安装依赖
npm install

# 复制环境变量并填写 API Key
copy .env.example .env

# 启动（开发可加 --watch）
npm start
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `PORT` | 服务端口，默认 3000，部署时可由平台注入 |
| `DEEPSEEK_API_KEY` | DeepSeek API Key（必填） |
| `DEEPSEEK_MODEL` | 模型，默认 `deepseek-chat` |

## API

- **GET /**  
  返回简单 HTML 页面，内容为「umini AI助手已启动」。

- **POST /chat**  
  请求体：`{ "message": "用户输入" }`  
  响应：流式 SSE，每段 `data: {"content":"..."}`，结束为 `data: [DONE]`。

## 示例请求

```bash
curl -X POST http://localhost:3000/chat ^
  -H "Content-Type: application/json" ^
  -d "{\"message\": \"你好\"}"
```
