export type LlmSettings = {
  apiKey: string;
  model?: string;
  endpoint?: string;
};

export class LlmApiError extends Error {
  status: number;
  apiMessage: string;

  constructor(status: number, apiMessage: string) {
    super(`LLM API error (${status}): ${apiMessage}`);
    this.name = 'LlmApiError';
    this.status = status;
    this.apiMessage = apiMessage;
  }
}

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';

export async function generateSummary(
  transcript: string,
  settings: LlmSettings,
  lang: 'en' | 'zh' = 'en',
): Promise<{ summary: string; keyPoints: string[]; actionItems: string[] }> {
  const endpoint = settings.endpoint ?? DEFAULT_ENDPOINT;
  const model = settings.model ?? DEFAULT_MODEL;

  const systemPrompt = lang === 'zh'
    ? `你是一个专业的会议/录音内容分析助手。请对以下转录内容进行分析，返回JSON格式：
{
  "summary": "一段简洁的总结（2-3句话）",
  "keyPoints": ["要点1", "要点2", ...],
  "actionItems": ["待办事项1", "待办事项2", ...]
}
如果没有待办事项，actionItems返回空数组。只返回JSON，不要添加其他文字。`
    : `You are a professional meeting/recording content analyzer. Analyze the following transcript and return JSON:
{
  "summary": "A concise summary (2-3 sentences)",
  "keyPoints": ["Key point 1", "Key point 2", ...],
  "actionItems": ["Action item 1", "Action item 2", ...]
}
If there are no action items, return an empty array. Return only JSON, no additional text.`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcript.slice(0, 12000) },
      ],
      temperature: 0.3,
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new LlmApiError(response.status, body || response.statusText || 'Unknown error');
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content?.trim() ?? '';

  try {
    const jsonStr = content.replace(/^```json\s*/, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(jsonStr) as {
      summary?: string;
      keyPoints?: string[];
      actionItems?: string[];
    };

    return {
      summary: parsed.summary ?? '',
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
    };
  } catch {
    return {
      summary: content,
      keyPoints: [],
      actionItems: [],
    };
  }
}
