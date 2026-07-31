import Anthropic from '@anthropic-ai/sdk';
import { anthropicCost } from '@/lib/providers/pricing';
import { BURNED_IN_TITLE_SYSTEM_PROMPT } from '@/lib/prompts/burned-in-title';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 512;

const TRANSCRIBE_TOOL: Anthropic.Tool = {
  name: 'transcribe_title',
  description: 'Report the burned-in hook title found in the (top-half-cropped) video frames.',
  input_schema: {
    type: 'object',
    properties: {
      primaryTitle: { type: 'string' },
      additionalTitles: { type: 'array', items: { type: 'string' } },
      noTextFound: { type: 'boolean' },
    },
    required: ['primaryTitle', 'additionalTitles', 'noTextFound'],
  },
};

export type BurnedInTitleResult = {
  primaryTitle: string | null;
  additionalTitles: string[];
  noTextFound: boolean;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
};

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY must be set');
  client = new Anthropic({ apiKey: key });
  return client;
}

export async function transcribeBurnedInTitle(jpegs: Buffer[]): Promise<BurnedInTitleResult> {
  if (jpegs.length === 0) throw new Error('transcribeBurnedInTitle: no frames provided');

  const imageBlocks: Anthropic.ImageBlockParam[] = jpegs.map((buf) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') },
  }));

  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: BURNED_IN_TITLE_SYSTEM_PROMPT,
    tools: [TRANSCRIBE_TOOL],
    tool_choice: { type: 'tool', name: 'transcribe_title' },
    messages: [{ role: 'user', content: imageBlocks }],
  });

  const toolUse = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) throw new Error(`burned-in-title: no tool_use block in response (stop_reason=${res.stop_reason})`);

  const out = toolUse.input as { primaryTitle: string; additionalTitles: string[]; noTextFound: boolean };

  const tokensIn = res.usage.input_tokens;
  const tokensOut = res.usage.output_tokens;
  const costUsd = anthropicCost(MODEL, { input: tokensIn, output: tokensOut });

  return {
    primaryTitle: out.noTextFound || !out.primaryTitle?.trim() ? null : out.primaryTitle.trim(),
    additionalTitles: out.additionalTitles ?? [],
    noTextFound: out.noTextFound,
    costUsd,
    tokensIn,
    tokensOut,
  };
}
