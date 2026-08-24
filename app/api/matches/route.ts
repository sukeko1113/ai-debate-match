import { createMatch } from '@/application/create-match';
import { buildMatchSnapshot } from '@/application/match-snapshot';
import {
  DEFAULT_MOTION_FILE,
  DEFAULT_RULE_SET_FILE,
  loadMotion,
  loadRuleSet,
} from '@/infrastructure/content';
import { createMatchRequestSchema } from '@/schemas/api';

import { errorResponse, readJsonBody, serverDeps, successResponse } from '../_shared/http';

/**
 * POST /api/matches（設計 §14.3）。
 * 試合を作り、`ready` の MatchSnapshot を 201 で返す。
 *
 * Phase 1 は motion も rule set も同梱の1件だけである（設計 §4）。
 * 要求された code が同梱のものと違えば、勝手に別のものを使わずに拒否する。
 */
export async function POST(request: Request) {
  const parsed = createMatchRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return errorResponse('INVALID_HUMAN_OUTPUT', '試合作成の入力が不正である（設計 §14.3）。', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const ruleSet = loadRuleSet(DEFAULT_RULE_SET_FILE);
  const motion = loadMotion(DEFAULT_MOTION_FILE);

  if (parsed.data.ruleSetCode !== ruleSet.code || parsed.data.motionCode !== motion.code) {
    return errorResponse(
      'INVALID_HUMAN_OUTPUT',
      'Phase 1 が扱えるのは同梱の motion と rule set だけである（設計 §4）。',
      {
        requested: { motionCode: parsed.data.motionCode, ruleSetCode: parsed.data.ruleSetCode },
        available: { motionCode: motion.code, ruleSetCode: ruleSet.code },
      },
    );
  }

  const deps = serverDeps();
  const created = await createMatch(deps, {
    ruleSet,
    motion,
    playerName: parsed.data.playerName,
    difficulty: parsed.data.difficulty,
  });

  return successResponse(await buildMatchSnapshot(deps.repository, created.state), 201);
}
