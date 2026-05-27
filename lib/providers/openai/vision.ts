import 'server-only';
import OpenAI from 'openai';
import type { VisionInput, VisionPassResult, VisionProvider } from '../types';
import { openaiChatCost } from '../pricing';
import { VISION_SYSTEM_PROMPT } from '@/lib/prompts/vision';

const MODEL = 'gpt-4o';
const MAX_TOKENS = 1024;

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (client) return client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY must be set');
  client = new OpenAI({ apiKey: key });
  return client;
}

const DESCRIBE_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'describe_video',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scene: { type: 'string' },
        subject: { type: 'string' },
        setting: { type: 'string' },
        vibe: { type: 'array', items: { type: 'string' } },
        visualHook: { type: 'string' },
      },
      required: ['scene', 'subject', 'setting', 'vibe', 'visualHook'],
    },
  },
};

export const openaiVision: VisionProvider = {
  id: 'openai',
  needsFrames: true,
  async describe(input: VisionInput): Promise<VisionPassResult> {
    if (input.kind !== 'frames') {
      throw new Error(`openai vision requires frames input, got ${input.kind}`);
    }

    const imageBlocks = input.jpegs.map((buf) => ({
      type: 'image_url' as const,
      image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` },
    }));

    const res = await openai().chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      response_format: DESCRIBE_SCHEMA,
      messages: [
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        { role: 'user', content: imageBlocks },
      ],
    });

    const text = res.choices[0]?.message?.content;
    if (!text) {
      throw new Error(`vision (openai): empty completion (finish_reason=${res.choices[0]?.finish_reason})`);
    }
    const out = JSON.parse(text) as {
      scene: string;
      subject: string;
      setting: string;
      vibe: string[];
      visualHook: string;
    };

    const tokensIn = res.usage?.prompt_tokens ?? 0;
    const tokensOut = res.usage?.completion_tokens ?? 0;
    const costUsd = openaiChatCost(MODEL, { input: tokensIn, output: tokensOut });

    return {
      description: { ...out, rawJson: out },
      tokensIn,
      tokensOut,
      costUsd,
    };
  },
};
