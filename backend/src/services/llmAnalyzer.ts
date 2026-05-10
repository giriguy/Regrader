import OpenAI from 'openai';
import fs from 'node:fs/promises';

const BASE_URL = process.env.DFLASH_BASE_URL ?? 'http://127.0.0.1:8000/v1';
const MODEL = process.env.DFLASH_MODEL ?? 'mlx-community/Qwen3.5-9B-MLX-4bit';
const MAX_TOKENS = 1500;

const client = new OpenAI({ baseURL: BASE_URL, apiKey: 'not-needed' });

export type AnalyzedQuestion = {
  points_missed: number | null;
  confidence: 'high' | 'medium' | 'low';
  justification: string;
  draft_request: string;
  should_regrade: boolean;
};

export type RubricItemForAnalyzer = {
  description: string;
  weight: number;
  applied: boolean;
  group_description: string | null;
};

export type AnalyzeQuestionInput = {
  course_short_name: string;
  assignment_title: string;
  question_label: string;
  question_title: string;
  max_points: number;
  points_awarded: number;
  scoring_type: 'positive' | 'negative';
  rubric_items: RubricItemForAnalyzer[];
  answer_image_path: string | null;
};

const SYSTEM_PROMPT = `You are reviewing one graded exam question on behalf of the student. Decide whether the deduction is defensible. Be conservative — false positives waste a professor's time and damage the student's credibility.

You see:
- The question's max points and the student's score.
- The full rubric, with each item marked APPLIED or NOT APPLIED.
- For "positive" scoring, applied items add their weight. For "negative" scoring, applied items subtract.
- The student's actual answer as an image of the cropped PDF region (when provided).

Flag a regrade ONLY if you have specific evidence that:
- An APPLIED penalty item misreads what the student wrote, OR
- A NOT-APPLIED credit item should have been applied because the student's work satisfies its description, OR
- The grading is internally inconsistent.

Do NOT flag deductions that are clearly correct, or where the student simply didn't address the rubric item.

Confidence:
- "high": clear evidence; you'd stake your reputation on it.
- "medium": reasonable case but a grader could push back.
- "low": worth mentioning but you'd hesitate to send.

Draft requests are 2-4 sentences, polite, specific, address the grader (not the student), reference rubric items by their text, and avoid emotional appeals.

Return STRICT JSON, no prose, no fences:
{
  "should_regrade": boolean,
  "points_missed": number | null,    // how many points you think were unfairly lost; null if not regrading
  "confidence": "high" | "medium" | "low",
  "justification": "why this deduction looks wrong (or why it doesn't)",
  "draft_request": "the regrade request to send, or empty string if should_regrade is false"
}`;

function rubricLine(r: RubricItemForAnalyzer): string {
  const tag = r.applied ? 'APPLIED' : 'NOT APPLIED';
  const sign = r.weight >= 0 ? '+' : '';
  const grp = r.group_description ? ` [${r.group_description}]` : '';
  // strip $$...$$ LaTeX delimiters for readability
  const desc = r.description.replace(/\$\$([^$]+)\$\$/g, '$1');
  return `  - [${tag}] (${sign}${r.weight} pts)${grp} ${desc}`;
}

export async function analyzeQuestion(
  input: AnalyzeQuestionInput,
): Promise<AnalyzedQuestion> {
  const lines = [
    `Course: ${input.course_short_name}`,
    `Assignment: ${input.assignment_title}`,
    `Question: ${input.question_label} — ${input.question_title}`,
    `Max points: ${input.max_points}`,
    `Score given: ${input.points_awarded} / ${input.max_points}`,
    `Scoring type: ${input.scoring_type}`,
    '',
    'Rubric:',
    ...input.rubric_items.map(rubricLine),
    '',
    input.answer_image_path
      ? "The student's answer is shown as an image (cropped from the graded PDF)."
      : "(no answer image available — work from the rubric and score)",
    '',
    'Return JSON only.',
  ];

  // dflash-mlx 9B via the FastAPI wrapper is text-only for now. We dropped
  // image support intentionally in the wrapper; pass the image as a hint that
  // it exists but don't require vision. (Future: when the wrapper handles
  // vision, attach the cropped PNG as an image_url content block.)
  if (input.answer_image_path) {
    try {
      await fs.access(input.answer_image_path);
    } catch {
      // image missing on disk; just continue without
    }
  }

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: lines.join('\n') },
    ],
    response_format: { type: 'json_object' },
  });

  const text = response.choices[0]?.message?.content ?? '';
  return parseAnalyzed(text);
}

function parseAnalyzed(raw: string): AnalyzedQuestion {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  let candidate = fenced ? fenced[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error(`LLM response was not valid JSON:\n${raw.slice(0, 500)}`);
    }
    parsed = JSON.parse(candidate.slice(start, end + 1));
  }

  const o = (parsed as Record<string, unknown>) ?? {};
  const conf = String(o.confidence ?? 'low').toLowerCase();
  const confidence =
    conf === 'high' || conf === 'medium' || conf === 'low' ? conf : 'low';
  const should = Boolean(o.should_regrade);
  return {
    should_regrade: should,
    points_missed: typeof o.points_missed === 'number' ? o.points_missed : null,
    confidence,
    justification: String(o.justification ?? ''),
    draft_request: should ? String(o.draft_request ?? '') : '',
  };
}
