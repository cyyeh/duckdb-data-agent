import Anthropic from '@anthropic-ai/sdk';
import { VerifyLlmStep } from './types';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

export interface JudgeResult {
  pass: boolean;
  score: number;
  reasoning: string;
}

export async function runLlmJudge(
  pageContent: string,
  step: VerifyLlmStep
): Promise<JudgeResult> {
  const threshold = step.pass_threshold ?? 0.8;
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `You are an E2E test judge. Given the page content below, evaluate whether it satisfies the criteria.

<page_content>
${pageContent}
</page_content>

<criteria>
${step.criteria}
</criteria>

Respond in exactly this JSON format:
{"score": 0.0 to 1.0, "reasoning": "brief explanation"}`,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return { pass: false, score: 0, reasoning: `Failed to parse LLM judge response: ${text}` };
  }

  const parsed = JSON.parse(jsonMatch[0]) as { score: number; reasoning: string };

  return {
    pass: parsed.score >= threshold,
    score: parsed.score,
    reasoning: parsed.reasoning,
  };
}
