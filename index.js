/**
 * umini - AI 聊天后端
 * 基于 Node.js + Express，使用 DeepSeek API（OpenAI 兼容格式）
 */

require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

const app = express();

// 解析 JSON 请求体
const cors = require('cors');

// 允许所有来源访问（开发阶段用这个最方便）
app.use(cors());
app.use(express.json());

// DeepSeek 客户端（OpenAI 兼容）
const openai = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: DEEPSEEK_BASE_URL,
});

// ---------------------------------------------------------------------------
// 路由：根路径 - 简单状态页
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>umini</title>
</head>
<body>
  <h1>umini AI助手已启动</h1>
</body>
</html>
  `);
});

// ---------------------------------------------------------------------------
// 路由：/chat - 接收用户消息，返回 AI 流式回复
// ---------------------------------------------------------------------------
app.post('/chat', async (req, res) => {
  const { message } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: '请提供 message 字段（字符串）' });
  }

  if (!DEEPSEEK_API_KEY) {
    return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY，请在 .env 中设置' });
  }

  // 设置 SSE 流式响应
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁用 nginx 缓冲
  res.flushHeaders();

  try {
    const stream = await openai.chat.completions.create({
      model: DEEPSEEK_MODEL,
      messages: [
        { 
          role: 'system', 
          content: '你的名字是UMINI，是一个热情、友好的AI助手。由UMINI团队创造。回答要简洁、有帮助。不要自称DeepSeek，也不要提及深度求索公司。' 
        },
        { role: 'user', content: message }
      ],
      stream: true,
    });
    
    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        // SSE 格式：data: 内容\n\n
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      }
    }

    // 发送结束标记
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('/chat 错误:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message || 'AI 请求失败' })}\n\n`);
    res.end();
  }
});

// ---------------------------------------------------------------------------
// 启动服务
// ---------------------------------------------------------------------------
// 导出 app 供 Vercel 使用
module.exports = app;

// 仅在本地开发时监听端口
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`umini 已启动: http://localhost:${PORT}`);
    if (!DEEPSEEK_API_KEY) {
      console.warn('警告: 未设置 DEEPSEEK_API_KEY，/chat 将不可用');
    }
  });
}
