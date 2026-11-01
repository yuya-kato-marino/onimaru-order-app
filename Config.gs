/**
 * Config.gs — シート名・列・設定の読み込み・共通の小さな関数
 *
 * トークンやAPIキーはここに書かない。すべてスクリプトプロパティに入れる
 * （プロジェクトの設定 → スクリプト プロパティ）。
 *
 *   LINE_CHANNEL_ACCESS_TOKEN … LINE Developers の「チャネルアクセストークン（長期）」
 *   ANTHROPIC_API_KEY         … Claude API のキー
 *   WEBHOOK_KEY               … Webhook URL の末尾に付ける合言葉（?key=…）。自分で決めた英数字
 *   CLAUDE_MODEL              … 省略時 claude-opus-5-5
 *   CLAUDE_EFFORT             … 省略時 medium（low / medium / high）
 *   SPREADSHEET_ID / DRIVE_FOLDER_ID / BOT_USER_ID … setup() が自動で入れる
 *   TEST_FOLDER_ID            … runSampleTest() 用。テスト画像を入れたドライブのフォルダID
 */

var SHEETS = {
  INVOICE: '伝票',
  LINES: '明細',
  SUMMARY: '月次集計',
  PRICE: '単価履歴',
  MASTER: '品目マスタ',
  SETTINGS: '設定',
  LOG: 'ログ',
  QUEUE: 'キュー',
  TEST: 'テスト正解'
};

var HEADERS = {};
HEADERS[SHEETS.INVOICE] = ['伝票ID', '受信日時', '業者ID', '業者', '店舗', '日付', '伝票番号', '明細件数', '明細計', '小計', 'VAT', '配送料', '合計', '検算', '状態', '指摘', '確認日時', '元ファイル', 'ファイルハッシュ', '宛先（読取）', '業者名（読取）', '送信者', 'メッセージID'];
HEADERS[SHEETS.LINES] = ['伝票ID', '日付', '業者', '店舗', 'No', '品目（原文）', '品目（標準名）', '数量', '単位', '単価', '金額', '検算', '数量（原文）', 'メモ'];
HEADERS[SHEETS.PRICE] = ['業者', '品目（標準名）', '単位', '日付', '単価', '直近平均', '変動率', '店舗', '状態', '伝票ID'];
HEADERS[SHEETS.MASTER] = ['業者ID', '標準名（日本語）', '標準名（タイ語）', '単位', '参考単価', '別名（カンマ区切り）', 'メモ'];
HEADERS[SHEETS.LOG] = ['日時', '区分', 'グループID', 'グループ名', '送信者ID', '送信者名', '種類', '結果', '理由', '伝票ID', 'メッセージID'];
HEADERS[SHEETS.QUEUE] = ['受信日時', 'イベントID', 'グループID', '送信者ID', '種類', 'メッセージID', 'ファイル名', '状態', '試行回数', '更新日時', '備考', 'ファイルID', 'イベント'];
HEADERS[SHEETS.TEST] = ['日付', '合計', '配送料', '明細（標準名=数量:金額 を ; で区切る）'];

/* 設定シート：左（A〜J）が業者の表、右（L〜M）が全体の設定 */
var SETTINGS_SUPPLIER_HEADERS = ['業者ID', '業者名', '店舗', 'グループID', '送信者ID（空欄＝誰でも／複数はカンマ区切り）', '形式（画像／PDF／両方）', '既定配送料', 'VAT率（%）', '有効', 'メモ'];
var SETTINGS_GLOBAL_COL = 12; // L列
var GLOBAL_KEYS = {
  REPORT_TO: '報告の送り先ID',
  THRESHOLD: '単価変動のしきい値（%）',
  AVG_N: '平均に使う直近件数',
  TOLERANCE: '検算の許容差（バーツ）',
  MAX_DAYS: '日付のずれの許容（日）'
};
var GLOBAL_DEFAULTS = [
  [GLOBAL_KEYS.REPORT_TO, '', 'U…（自分の userId）。3人グループに送るときは C…（グループID）'],
  [GLOBAL_KEYS.THRESHOLD, 20, '直近の平均からこれ以上動いたら報告に出す'],
  [GLOBAL_KEYS.AVG_N, 5, '平均を取る直近の件数'],
  [GLOBAL_KEYS.TOLERANCE, 1, '数量×単価と金額、明細の合計と伝票の合計の許容差'],
  [GLOBAL_KEYS.MAX_DAYS, 45, '伝票の日付が受信日からこれ以上前なら要確認']
];

var STATUS = { UNCHECKED: '未確認', NEEDS_CHECK: '要確認', CONFIRMED: '確認済み' };
var TZ = 'Asia/Bangkok';

/* ---------- スクリプトプロパティ ---------- */
function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}
function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

/* ---------- スプレッドシート ---------- */
var ss_cache_ = null;
function ss_() {
  if (ss_cache_) return ss_cache_;
  var id = prop_('SPREADSHEET_ID');
  ss_cache_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss_cache_) throw new Error('スプレッドシートが見つかりません。先に setup() を実行してください');
  return ss_cache_;
}
function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」がありません。setup() を実行してください');
  return sh;
}

/** 1行目を見出しとして表を読む。rows[i] はシートの i+2 行目 */
function readTable_(name) {
  var sh = sheet_(name);
  var lastRow = sh.getLastRow();
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var values = lastRow >= 1 ? sh.getRange(1, 1, lastRow, lastCol).getValues() : [[]];
  var headers = values[0].map(String);
  var col = {};
  headers.forEach(function (h, i) { if (h) col[h] = i; });
  return { sheet: sh, headers: headers, col: col, rows: values.slice(1) };
}

/** 見出しの順に並べた1行を作る */
function rowFromObj_(headers, obj) {
  return headers.map(function (h) { return obj[h] === undefined || obj[h] === null ? '' : obj[h]; });
}

function appendRows_(sh, rows) {
  if (!rows.length) return 0;
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
  return start;
}

/** シートの特定の行を開くリンク */
function sheetRowUrl_(sheetName, firstRow, lastRow, lastColLetter) {
  var sh = sheet_(sheetName);
  var range = 'A' + firstRow + (lastRow && lastColLetter ? ':' + lastColLetter + lastRow : '');
  return ss_().getUrl() + '#gid=' + sh.getSheetId() + '&range=' + range;
}

/* ---------- 設定シート ---------- */
function getSettings_() {
  var sh = sheet_(SHEETS.SETTINGS);
  var last = Math.max(sh.getLastRow(), 2);
  var vals = sh.getRange(1, 1, last, SETTINGS_GLOBAL_COL + 1).getValues();
  var suppliers = [];
  var global = {};
  for (var i = 1; i < vals.length; i++) {
    var r = vals[i];
    if (String(r[0]).trim()) {
      suppliers.push({
        id: String(r[0]).trim(),
        name: String(r[1]).trim(),
        store: String(r[2]).trim(),
        groupId: String(r[3]).trim(),
        senders: String(r[4]).split(/[\s,、，]+/).map(function (s) { return s.trim(); }).filter(String),
        format: String(r[5]).trim() || '画像',
        defaultShipping: toNum_(r[6]) || 0,
        vatRate: toNum_(r[7]) || 0,
        enabled: r[8] === true || String(r[8]).toUpperCase() === 'TRUE'
      });
    }
    var k = String(r[SETTINGS_GLOBAL_COL - 1]).trim();
    if (k) global[k] = r[SETTINGS_GLOBAL_COL];
  }
  return {
    suppliers: suppliers,
    reportTo: String(global[GLOBAL_KEYS.REPORT_TO] || '').trim(),
    threshold: toNum_(global[GLOBAL_KEYS.THRESHOLD]) || 20,
    avgN: toNum_(global[GLOBAL_KEYS.AVG_N]) || 5,
    tolerance: toNum_(global[GLOBAL_KEYS.TOLERANCE]) != null ? toNum_(global[GLOBAL_KEYS.TOLERANCE]) : 1,
    maxDays: toNum_(global[GLOBAL_KEYS.MAX_DAYS]) || 45
  };
}

function findSupplierByGroup_(settings, groupId) {
  if (!groupId) return null;
  for (var i = 0; i < settings.suppliers.length; i++) {
    var s = settings.suppliers[i];
    if (s.enabled && s.groupId === groupId) return s;
  }
  return null;
}
function findSupplierById_(settings, id) {
  for (var i = 0; i < settings.suppliers.length; i++) {
    if (settings.suppliers[i].id === id) return settings.suppliers[i];
  }
  return null;
}

/** 品目マスタのうち、指定業者の品目 */
function getMasterItems_(supplierId) {
  var t = readTable_(SHEETS.MASTER);
  var c = t.col;
  return t.rows.filter(function (r) {
    return String(r[c['業者ID']]).trim() === supplierId && String(r[c['標準名（日本語）']]).trim();
  }).map(function (r) {
    return {
      std: String(r[c['標準名（日本語）']]).trim(),
      thai: String(r[c['標準名（タイ語）']]).trim(),
      unit: String(r[c['単位']]).trim(),
      refPrice: toNum_(r[c['参考単価']]),
      aliases: String(r[c['別名（カンマ区切り）']]).split(/[,、，\n]+/).map(function (s) { return s.trim(); }).filter(String)
    };
  });
}

/* ---------- ログ ---------- */
function log_(o) {
  try {
    var sh = sheet_(SHEETS.LOG);
    sh.appendRow(rowFromObj_(HEADERS[SHEETS.LOG], {
      '日時': new Date(),
      '区分': o.kind || '',
      'グループID': o.groupId || '',
      'グループ名': o.groupName || '',
      '送信者ID': o.userId || '',
      '送信者名': o.userName || '',
      '種類': o.type || '',
      '結果': o.result || '',
      '理由': String(o.reason || '').slice(0, 1000),
      '伝票ID': o.invoiceId || '',
      'メッセージID': o.messageId || ''
    }));
  } catch (err) {
    console.error('ログを書けませんでした', err, JSON.stringify(o));
  }
}

function errMsg_(err) {
  return String((err && err.message) || err);
}

/* ---------- 日付 ---------- */
function toYmd_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  var s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}
function ymdToDate_(ymd) {
  if (!ymd) return '';
  var p = ymd.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function sha256Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function (b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}
