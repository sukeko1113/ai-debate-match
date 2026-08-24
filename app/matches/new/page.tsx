import Link from 'next/link';

import { SetupForm } from '@/components/debate/setup-form';
import {
  DEFAULT_MOTION_FILE,
  DEFAULT_RULE_SET_FILE,
  loadMotion,
  loadRuleSet,
} from '@/infrastructure/content';

/**
 * Setup 画面（設計 §5.1 `/matches/new`）。
 *
 * motion と rule set は同梱の契約ファイルから読む。画面が競技条件を持たない（設計 §6.4）。
 * 構成は A1（人間）＋AI7席で固定である（設計 §4）。
 */
export default function SetupPage() {
  const motion = loadMotion(DEFAULT_MOTION_FILE);
  const ruleSet = loadRuleSet(DEFAULT_RULE_SET_FILE);

  const competitionSections = ruleSet.slots.filter((slot) => slot.kind !== 'prep').length;
  const totalMinutes = Math.round(
    ruleSet.slots.reduce((total, slot) => total + slot.seconds, 0) / 60,
  );

  return (
    <main>
      <h1>試合の準備</h1>

      <p>
        あなたは肯定側A1として立論を書き、質疑に答えます。残る7席はAIが担当します。
        競技{competitionSections}セクションと準備スロットを合わせて計{totalMinutes}分の形式です。
      </p>

      <SetupForm
        motionCode={motion.code}
        motionTextJa={motion.textJa}
        ruleSetCode={ruleSet.code}
      />

      <section aria-labelledby="evidence-heading">
        <h2 id="evidence-heading">Evidence カード</h2>
        <p>
          この論題には動作確認用のカードが{motion.seedEvidenceCards.length}件付属しており、
          試合の作成時に取り込まれます。付属カードはダミーで、実在の出典ではありません。
        </p>
      </section>

      <div className="notice">
        <p>
          この判定はAIによる暫定評価であり、公式ジャッジではありません。
        </p>
      </div>

      <footer>
        <p>
          <Link href="/">最初の画面へ戻る</Link>
        </p>
      </footer>
    </main>
  );
}
