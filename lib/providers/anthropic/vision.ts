import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { VisionInput, VisionPassResult, VisionProvider } from '../types';
import { anthropicCost } from '../pricing';
import { VISION_SYSTEM_PROMPT } from '@/lib/prompts/vision';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;

const DESCRIBE_TOOL: Anthropic.Tool = {
  name: 'describe_video',
  description: 'Emit a structured description of the video given its sampled frames.',
  input_schema: {
    type: 'object',
    properties: {
      scene: { type: 'string' },
      subject: { type: 'string' },
      setting: { type: 'string' },
      vibe: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 6 },
      visualHook: { type: 'string' },
    },
    required: ['scene', 'subject', 'setting', 'vibe', 'visualHook'],
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

export const anthropicVision: VisionProvider = {
  id: 'anthropic',
  needsFrames: true,
  async describe(input: VisionInput): Promise<VisionPassResult> {
    if (input.kind !== 'frames') {
      throw new Error(`anthropic vision requires frames input, got ${input.kind}`);
    }
    const imageBlocks: Anthropic.ImageBlockParam[] = input.jpegs.map((buf) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') },
    }));

    const res = await anthropic().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: VISION_SYSTEM_PROMPT,
      tools: [DESCRIBE_TOOL],
      tool_choice: { type: 'tool', name: 'describe_video' },
      messages: [{ role: 'user', content: imageBlocks }],
    });

    const toolUse = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!toolUse) throw new Error(`vision: no tool_use block in response (stop_reason=${res.stop_reason})`);

    const out = toolUse.input as {
      scene: string;
      subject: string;
      setting: string;
      vibe: string[];
      visualHook: string;
    };

    const tokensIn = res.usage.input_tokens;
    const tokensOut = res.usage.output_tokens;
    const costUsd = anthropicCost(MODEL, { input: tokensIn, output: tokensOut });

    return {
      description: { ...out, rawJson: out },
      tokensIn,
      tokensOut,
      costUsd,
    };
  },
};
