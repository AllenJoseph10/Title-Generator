import 'server-only';
import OpenAI from 'openai';
import type { GenerationProvider, GenerationPassResult, GenerateArgs } from '../types';
import { openaiChatCost } from '../pricing';
import { HOOK_FAMILIES, isHookFamily, type HookFamily } from '@/lib/hooks/taxonomy';
import {
  GENERATE_RULES,
  buildTaxonomyBlock,
  buildCreatorBlock,
  buildUserMessage,
} from '@/lib/prompts/generate';

const MODEL = 'gpt-4o';
const MAX_TOKENS = 2048;
const TITLE_COUNT = 10;

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (client) return client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY must be set');
  client = new OpenAI({ apiKey: key });
  return client;
}

const TITLES_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'emit_titles',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        titles: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              hookFamily: { type: 'string', enum: [...HOOK_FAMILIES] },
            },
            required: ['text', 'hookFamily'],
          },
        },
      },
      required: ['titles'],
    },
  },
};

export const openaiGeneration: GenerationProvider = {
  id: 'openai',
  async generate(args: GenerateArgs): Promise<GenerationPassResult> {
    const systemText = [
      GENERATE_RULES,
      buildTaxonomyBlock(),
      buildCreatorBlock({ styleBrief: args.styleBrief, styleFingerprint: args.styleFingerprint }),
    ].join('\n\n');

    let userText = buildUserMessage({
      description: args.description,
      retrievedExamples: args.retrievedExamples,
      requiredFamilies: args.requiredFamilies,
    });
    if (args.steering && args.steering.trim().length > 0) {
      userText += `\n\nAdditional creative direction (apply to ALL 10 titles): ${args.steering.trim().slice(0, 300)}`;
    }

    const res = await openai().chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      response_format: TITLES_SCHEMA,
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: userText },
      ],
    });

    const text = res.choices[0]?.message?.content;
    if (!text) {
      throw new Error(`generation (openai): empty completion (finish_reason=${res.choices[0]?.finish_reason})`);
    }
    const raw = JSON.parse(text) as { titles: Array<{ text: string; hookFamily: string }> };
    if (!Array.isArray(raw.titles) || raw.titles.length !== TITLE_COUNT) {
      throw new Error(`generation (openai): expected ${TITLE_COUNT} titles, got ${raw.titles?.length}`);
    }

    const titles = raw.titles.map((t, i): { text: string; hookFamily: HookFamily } => {
      if (!isHookFamily(t.hookFamily)) {
        throw new Error(`generation (openai): invalid hookFamily at index ${i}: ${t.hookFamily}`);
      }
      return { text: t.text, hookFamily: t.hookFamily };
    });

    const tokensIn = res.usage?.prompt_tokens ?? 0;
    const tokensOut = res.usage?.completion_tokens ?? 0;
    const costUsd = openaiChatCost(MODEL, { input: tokensIn, output: tokensOut });

    // OpenAI does not have Anthropic's prompt-cache mechanism on its chat API.
    return { titles, tokensIn, tokensInCacheRead: 0, tokensInCacheWrite: 0, tokensOut, costUsd };
  },
};
