import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { GenerationProvider, GenerationPassResult, GenerateArgs } from '../types';
import { anthropicCost } from '../pricing';
import { HOOK_FAMILIES, isHookFamily, type HookFamily } from '@/lib/hooks/taxonomy';
import {
  GENERATE_RULES,
  buildTaxonomyBlock,
  buildCreatorBlock,
  buildUserMessage,
} from '@/lib/prompts/generate';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2048;
const TITLE_COUNT = 10;

const EMIT_TITLES_TOOL: Anthropic.Tool = {
  name: 'emit_titles',
  description: 'Emit exactly 10 titles, each tagged with a hook family id.',
  input_schema: {
    type: 'object',
    properties: {
      titles: {
        type: 'array',
        minItems: TITLE_COUNT,
        maxItems: TITLE_COUNT,
        items: {
          type: 'object',
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
};

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY must be set');
  client = new Anthropic({ apiKey: key });
  return client;
}

export const anthropicGeneration: GenerationProvider = {
  id: 'anthropic',
  async generate(args: GenerateArgs): Promise<GenerationPassResult> {
    // system is a 2-block array: [rules+taxonomy (cached), creator block (cached)].
    // Cache breakpoint lives on the LAST block; everything up to and including it is cached.
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: 'text', text: `${GENERATE_RULES}\n\n${buildTaxonomyBlock()}` },
      {
        type: 'text',
        text: buildCreatorBlock({ styleBrief: args.styleBrief, styleFingerprint: args.styleFingerprint }),
        cache_control: { type: 'ephemeral' },
      },
    ];

    let userText = buildUserMessage({
      description: args.description,
      retrievedExamples: args.retrievedExamples,
      requiredFamilies: args.requiredFamilies,
    });
    if (args.steering && args.steering.trim().length > 0) {
      userText += `\n\nAdditional creative direction (apply to ALL 10 titles): ${args.steering.trim().slice(0, 300)}`;
    }

    const res = await anthropic().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemBlocks,
      tools: [EMIT_TITLES_TOOL],
      tool_choice: { type: 'tool', name: 'emit_titles' },
      messages: [{ role: 'user', content: userText }],
    });

    const toolUse = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!toolUse) throw new Error(`generation: no tool_use block (stop_reason=${res.stop_reason})`);

    const raw = toolUse.input as { titles: Array<{ text: string; hookFamily: string }> };
    if (!Array.isArray(raw.titles) || raw.titles.length !== TITLE_COUNT) {
      throw new Error(`generation: expected ${TITLE_COUNT} titles, got ${raw.titles?.length}`);
    }

    const titles = raw.titles.map((t, i): { text: string; hookFamily: HookFamily } => {
      if (!isHookFamily(t.hookFamily)) {
        throw new Error(`generation: invalid hookFamily at index ${i}: ${t.hookFamily}`);
      }
      return { text: t.text, hookFamily: t.hookFamily };
    });

    const u = res.usage;
    const tokensIn = u.input_tokens;
    const tokensInCacheRead = u.cache_read_input_tokens ?? 0;
    const tokensInCacheWrite = u.cache_creation_input_tokens ?? 0;
    const tokensOut = u.output_tokens;
    const costUsd = anthropicCost(MODEL, {
      input: tokensIn,
      output: tokensOut,
      cacheRead: tokensInCacheRead,
      cacheWrite: tokensInCacheWrite,
    });

    return { titles, tokensIn, tokensInCacheRead, tokensInCacheWrite, tokensOut, costUsd };
  },
};
