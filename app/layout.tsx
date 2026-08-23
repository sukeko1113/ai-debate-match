import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'AI英語ディベート練習',
  description:
    '準備型4人制ディベートを、人間1名とAI7席で練習するアプリ。判定はAIによる暫定評価であり、公式ジャッジではありません。',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
