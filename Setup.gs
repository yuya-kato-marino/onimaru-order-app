/**
 * Setup.gs — 初期設定（シートの作成・ドライブのフォルダ・トリガー）
 *
 * setup() は何度実行しても大丈夫（あるものは作り直さない）。
 */

var SUPPLIER_SEED = [
  // 業者ID, 業者名, 店舗, グループID, 送信者ID, 形式, 既定配送料, VAT率, 有効, メモ
  ['S01', 'ร้าน ศิริกานต์ ผักสด ตลาดคลองเตย', 'おにまる タイ', '', '', '画像', 150, 0, true, '八百屋。手書き伝票の写真。税なし。伝票番号は空欄'],
  ['S02', 'Noritake Farm Co.,Ltd.', 'おにまる タイ', '', '', 'PDF', 250, 7, true, 'のりたけファーム。送信者は空欄＝誰でも。見積書は記録しない（AIで判定）']
];

/* 品目マスタの初期値（八百屋）。単位は仮。参考単価は確認済みの伝票から自動で入る */
var MASTER_SEED = [
  ['S01', '豚ひき肉', 'หมูบด', 'kg', '', '', '単位は仮'],
  ['S01', '鶏もも', 'สะโพกไก่', 'kg', '', 'สะโพกไก่ 50-60g/ชิ้น', '単位は仮'],
  ['S01', '大根', 'หัวไชเท้า', 'kg', '', '', '単位は仮'],
  ['S01', 'にんじん', 'แครอท', 'kg', '', 'แคร์รอท', '単位は仮'],
  ['S01', '大葉', 'ใบโอบะ', '枚', '', 'โอบะ', '単位は仮'],
  ['S01', 'ネギ', 'ต้นหอมญี่ปุ่น', 'kg', '', '', '単位は仮']
];

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('スプレッドシートの「拡張機能 → Apps Script」で開いたプロジェクトから実行してください');
  setProp_('SPREADSHEET_ID', ss.getId());
  ss.setSpreadsheetTimeZone(TZ);

  var order = [SHEETS.INVOICE, SHEETS.LINES, SHEETS.SUMMARY, SHEETS.PRICE, SHEETS.MASTER, SHEETS.SETTINGS, SHEETS.LOG, SHEETS.QUEUE];
  order.forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (HEADERS[name] && sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight('bold').setBackground('#EEEEEE');
      sh.setFrozenRows(1);
    }
  });
  formatSheets_(ss);
  seedSettings_(ss.getSheetByName(SHEETS.SETTINGS));
  seedMaster_(ss.getSheetByName(SHEETS.MASTER));

  var def = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  if (!prop_('DRIVE_FOLDER_ID')) {
    var folder = DriveApp.createFolder('請求書_元ファイル（' + ss.getName() + '）');
    setProp_('DRIVE_FOLDER_ID', folder.getId());
  }
  if (prop_('LINE_CHANNEL_ACCESS_TOKEN') && !prop_('BOT_USER_ID')) {
    try { setProp_('BOT_USER_ID', lineBotUserId_()); } catch (e) { console.warn(errMsg_(e)); }
  }
  installTrigger_();
  checkSetup();
}

function formatSheets_(ss) {
  var inv = ss.getSheetByName(SHEETS.INVOICE);
  inv.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm');
  inv.getRange('F:F').setNumberFormat('yyyy-mm-dd');
  inv.getRange('I:M').setNumberFormat('#,##0.##');
  inv.getRange('Q:Q').setNumberFormat('yyyy-mm-dd hh:mm');
  var lines = ss.getSheetByName(SHEETS.LINES);
  lines.getRange('B:B').setNumberFormat('yyyy-mm-dd');
  lines.getRange('J:K').setNumberFormat('#,##0.##');
  lines.getRange('M:M').setNumberFormat('@');
  ss.getSheetByName(SHEETS.PRICE).getRange('D:D').setNumberFormat('yyyy-mm-dd');
  ss.getSheetByName(SHEETS.LOG).getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  var q = ss.getSheetByName(SHEETS.QUEUE);
  q.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  q.getRange('J:J').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  q.getRange('F:F').setNumberFormat('@');
  ss.getSheetByName(SHEETS.LOG).getRange('K:K').setNumberFormat('@');
}

function seedSettings_(sh) {
  if (sh.getLastRow() > 0) return;
  sh.getRange(1, 1, 1, SETTINGS_SUPPLIER_HEADERS.length).setValues([SETTINGS_SUPPLIER_HEADERS]).setFontWeight('bold').setBackground('#EEEEEE');
  sh.getRange(2, 1, SUPPLIER_SEED.length, SUPPLIER_SEED[0].length).setValues(SUPPLIER_SEED);
  sh.getRange(2, 9, 20, 1).insertCheckboxes();
  sh.getRange(2, 6, 20, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['画像', 'PDF', '両方'], true).build());
  sh.getRange(1, SETTINGS_GLOBAL_COL, 1, 3).setValues([['項目', '値', '説明']]).setFontWeight('bold').setBackground('#EEEEEE');
  sh.getRange(2, SETTINGS_GLOBAL_COL, GLOBAL_DEFAULTS.length, 3).setValues(GLOBAL_DEFAULTS);
  sh.setFrozenRows(1);
}

function seedMaster_(sh) {
  if (sh.getLastRow() > 1) return;
  sh.getRange(2, 1, MASTER_SEED.length, MASTER_SEED[0].length).setValues(MASTER_SEED);
}

function installTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'processQueue') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(1).create();
}

/** 設定の状態を「実行ログ」に出す */
function checkSetup() {
  var out = [];
  ['LINE_CHANNEL_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'WEBHOOK_KEY', 'SPREADSHEET_ID', 'DRIVE_FOLDER_ID', 'BOT_USER_ID'].forEach(function (k) {
    out.push((prop_(k) ? '✅ ' : '❌ ') + k + (prop_(k) ? '' : '（未設定）'));
  });
  out.push('モデル：' + (prop_('CLAUDE_MODEL') || CLAUDE_DEFAULT_MODEL) + '／effort：' + (prop_('CLAUDE_EFFORT') || 'medium'));
  var n = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'processQueue'; }).length;
  out.push((n ? '✅ ' : '❌ ') + '1分ごとのトリガー：' + n + '個');
  try {
    var s = getSettings_();
    out.push((s.reportTo ? '✅ ' : '❌ ') + '報告の送り先ID：' + (s.reportTo || '（未設定）'));
    s.suppliers.forEach(function (x) {
      out.push('・' + x.id + ' ' + x.name + '：' + (x.enabled ? '有効' : '無効') + '／グループ ' + (x.groupId || '未設定') +
        '／送信者 ' + (x.senders.length ? x.senders.length + '人' : '誰でも') + '／' + x.format);
    });
  } catch (e) {
    out.push('❌ 設定シート：' + errMsg_(e));
  }
  var text = out.join('\n');
  console.log(text);
  return text;
}
