// 协议描述：厂商只是预设，真正被适配的是 wire protocol。
export const PROTOCOLS = {
  'openai-completions': {
    id: 'openai-completions',
    label: 'OpenAI Chat Completions',
    requestPath: '/chat/completions',
    modelsPath: '/models',
    auth: 'bearer',
    stream: 'sse',
    text: 'messages[].content',
  },
  'openai-responses': {
    id: 'openai-responses',
    label: 'OpenAI Responses',
    requestPath: '/responses',
    modelsPath: '/models',
    auth: 'bearer',
    stream: 'sse',
    text: 'response.output_text.delta',
  },
  'anthropic-messages': {
    id: 'anthropic-messages',
    label: 'Anthropic Messages',
    requestPath: '/v1/messages',
    modelsPath: '/v1/models',
    auth: 'x-api-key',
    stream: 'sse',
    text: 'content_block_delta.text_delta',
  },
  'gemini-generate-content': {
    id: 'gemini-generate-content',
    label: 'Google Gemini generateContent',
    requestPath: '',
    modelsPath: '/models',
    auth: 'x-goog-api-key',
    stream: 'sse',
    text: 'candidates[].content.parts[].text',
  },
  'ollama-chat': {
    id: 'ollama-chat',
    label: 'Ollama Chat',
    requestPath: '/api/chat',
    modelsPath: '/api/tags',
    auth: 'none',
    stream: 'ndjson',
    text: 'message.content',
  },
}

export function getProtocol(id) {
  return PROTOCOLS[String(id || '')] || null
}

export function protocolIds() {
  return Object.keys(PROTOCOLS)
}
