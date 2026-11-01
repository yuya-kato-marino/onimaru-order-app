# CLAUDE.md — LINE請求書読み取りボット（タイ・おにまる）（invoice-bot フォルダ）

Claude Code が `invoice-bot/` で作業を始めるときに最初に読む指示書。
元の要件書：「要件書：LINE請求書読み取りボット（タイ・おにまる）」2026-11-01 加藤雄也（海外FC事業部）

## 1. 何を作るか

タイのおにまる店舗に仕入先から LINE グループで届く請求書（手書き伝票の写真・PDF）を読み取り、Googleスプレッドシートに記録する。
月末に「今月いくら使ったか（業者別・店舗別・合計）」「金額の大きい品目」「値上がりした品目」を見られるようにする。
仕組みと設定手順は README.md。

## 2. 決まっていること（変えるときは本人に確認）

| 項目 | 値 |
|---|---|
| 受け口・処理 | Google Apps Script（スプレッドシートに紐づいたスクリプト）。doPost はキューに書くだけ、1分ごとのトリガーで処理 |
| 反映方法 | Apps Script のエディタに貼り付け（clasp は使わない）（2026-11-01 決定） |
| スプレッドシート | 新しく作り、シートは setup() で自動作成（2026-11-01 決定） |
| ブックの構成 | 1ブックに全業者・全店舗を混在。業者・店舗は「設定」シートの行を足すだけで増やせる（2026-11-01 決定） |
| 読み取り | Claude API に画像・PDF をそのまま渡す（PDF のテキスト抽出はしない）。既定モデル claude-opus-5-5、effort medium、fallbacks "default" |
| 送信者の条件 | 八百屋は指定した人だけ。のりたけファームは送信者を指定しない（PDF なら誰でも）（2026-11-01 決定） |
| 配送料 | 伝票の「配送料」欄だけに入れる。明細と品目別の集計には入れない（2026-11-01 決定） |
| OK ボタン | シートの値で検算し直し、合わなければ「確認済み」にしない（2026-11-01 決定） |
| 支払い済みかどうか | 記録しない（重要ではない。合計金額が分かればよい）（2026-11-01） |
| 報告 | 加藤さんの個別トーク。送り先は「設定」の「報告の送り先ID」で変えられる（将来3人グループへ） |
| グループでの発言 | 一切しない |
| git | Claude は指定ブランチ `claude/line-invoice-reader-bot-cwdrz5` へ push まで行う（2026-11-01 本人の指示。当日夕方に GitHub 連携が通るようになった）。`la/` の「push は本人」とは別 |

## 3. 公開リポジトリに入れてよいもの・いけないもの

- 入れない：トークン、APIキー、Webhook URL、グループID、userId、価格の実データ（テストの正解・参考単価）。
- 価格の実データは `invoice-bot/_private/`（.gitignore で除外）に置く。本人には別途ファイルで渡す。
- 業者名・品目名・単位は入れてよい（連絡先は入れない）。

## 4. 未決事項（作業前に本人に確認する）

1. LINE 公式アカウントの新規作成（名前・プロバイダー）
2. お米業者を対象に含めるか（請求書PDF未受領）→ 当面は対象外
3. のりたけファームの請求書の実物（見積書のみ受領）。見積書は記録しない（AI が quotation と判定したらスキップ）
4. 品目マスタの単位の確定（肉・野菜 kg、大葉 枚 で仮置き）
5. 業者への事前説明（ボットがグループに入ること）
6. Claude API のキーの用意
7. 店舗名（「設定」の店舗は仮に「おにまる タイ」）

## 5. 注意点

- Apps Script の doPost はリクエストヘッダーを読めないので、LINE の署名は検証できない。代わりに Webhook URL の `?key=`、`destination`（ボットのID）、登録済みグループ・送信者の確認、LINE API からの取り直しで守っている。
- UrlFetchApp の待ち時間には上限がある。Claude の応答が遅くて失敗が続くときは CLAUDE_EFFORT を low にする。
- 画像1枚は約5MBまで。大きい画像はドライブの縮小画像（長辺2000px）を使う。
- コードを直したら、Apps Script で「デプロイを管理」→ 新バージョン にしないと doPost は古いまま。

## 6. 進み具合

### 2026-11-01
- `gas/` 一式を作成（受け口・キュー・判定・ドライブ保存・読み取り・正規化・検算・重複・報告・OK／要修正・月次集計・単価履歴・参考単価・過去分の一括取り込み・実物テスト）。
- `test/run-tests.js`（正規化・検算の単体テスト）、`test/run-flow-test.js`（Apps Script をまねた通し試験）が通ることを確認。
- 正解データ3枚を、AI がありがちな読み方（「05」を5と読む、配送料150を750と読む）をした想定で検算し、正解と一致することを確認（`_private/truth-test.js`）。
- 実物の画像での確認（README の D）は、LINE アカウントと Claude API キーの用意後。
- Claude 側から push できなかったため、本人が zip を GitHub の画面からアップロードして main に反映。
  - **フォルダが崩れ、16ファイルがリポジトリの一番上（`la/` `tw/` と同じ階層）に入った。** `invoice-bot/gas/` などは GitHub 上にない。
- 本人がスプレッドシート「請求書記録（タイ）」と Apps Script「請求書ボット（タイ）」を作り、README の B（手順6〜12：貼り付け・WEBHOOK_KEY・setup()・ウェブアプリのデプロイ）まで完了。exec URL は本人が控えている（ここには書かない）。

## 7. 次にやること（2026-11-01 時点）

1. **GitHub のフォルダ整理（優先）。** 一番上の `CLAUDE.md` はボット専用なのに、リポジトリ全体の指示書として読まれてしまう。
   ブランチ `claude/line-invoice-reader-bot-cwdrz5` には正しいフォルダ構成（`invoice-bot/`）で push 済み。Claude がこのブランチで main の一番上の16ファイルを消してから、本人がブランチを main にマージすれば片付く（本人の了承を得てから）。
   本人の PC で行う場合は PowerShell で：
   `git pull` → `mkdir invoice-bot\gas, invoice-bot\test` → `git mv *.gs appsscript.json invoice-bot\gas\` → `git mv gas-mock.js run-tests.js run-flow-test.js invoice-bot\test\` → `git mv README.md CLAUDE.md invoice-bot\` → commit → push
   整理後、README のファイルへのリンク（今は存在しないブランチを指している）を `main/invoice-bot/gas` に直す。
2. LINE 公式アカウントの作成（名前・プロバイダーを決める）→ README の A（手順1〜5）。
3. スクリプト プロパティに `LINE_CHANNEL_ACCESS_TOKEN` を入れ、`setup()` をもう一度実行（BOT_USER_ID が入る）→ README の C（手順13〜17：Webhook URL・検証・`id` で userId・グループ招待）。
4. Claude API キーを用意して `ANTHROPIC_API_KEY` に入れ、伝票画像3枚で README の D（手順18〜21：runSampleTest）。
