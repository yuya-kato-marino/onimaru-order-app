/**
 * Tests.gs — 実物の伝票画像で、読み取り結果が正解データと一致するか確かめる
 *
 * 準備：
 *   1. ドライブにフォルダを作り、テスト用の伝票画像（またはPDF）を入れる
 *   2. スクリプトプロパティ TEST_FOLDER_ID にそのフォルダのIDを入れる
 *   3. 「テスト正解」シートに正解を入れる（_private の InitialData.gs の loadTestAnswers() でも入る）
 *        日付 | 合計 | 配送料 | 明細（例：大根=1.1:38; にんじん=1:35）
 *   4. runSampleTest() を実行 → 「実行ログ」に結果が出る
 *
 * シートへの記録・LINEへの送信はしない（Claude API の料金は1枚ごとにかかる）。
 * TEST_SUPPLIER_ID（省略時 S01）の業者として読む。
 */
function runSampleTest() {
  var settings = getSettings_();
  var sup = findSupplierById_(settings, prop_('TEST_SUPPLIER_ID') || 'S01');
  if (!sup) throw new Error('テスト用の業者が「設定」にありません');
  var answers = readTestAnswers_();
  var master = getMasterItems_(sup.id);
  var files = DriveApp.getFolderById(prop_('TEST_FOLDER_ID')).getFiles();
  var report = [];
  var pass = 0, total = 0;

  while (files.hasNext()) {
    var f = files.next();
    var ct = f.getMimeType();
    if (!/^image\//.test(ct) && ct !== 'application/pdf') continue;
    total++;
    var refYmd = Utilities.formatDate(f.getDateCreated(), TZ, 'yyyy-MM-dd');
    var ai = claudeReadInvoice_({ blob: f.getBlob(), fileId: f.getId() }, sup, master, refYmd);
    if (ai.document_type !== 'invoice') {
      report.push('❌ ' + f.getName() + '：請求書ではないと判定（' + ai.document_type + '：' + ai.document_type_reason + '）');
      continue;
    }
    var inv = normalizeInvoice_(ai, master, { receivedYmd: refYmd, tolerance: settings.tolerance });
    validateInvoice_(inv, { tolerance: settings.tolerance, allowFix: true, defaultShipping: sup.defaultShipping, vatRate: sup.vatRate });
    var ans = answers[inv.date];
    var head = f.getName() + '（' + inv.date + '）';
    if (!ans) {
      report.push('❌ ' + head + '：この日付の正解がない（日付の読み間違いの可能性）／日付の表記「' + inv.dateRaw + '」');
      continue;
    }
    var diffs = compareWithAnswer_(inv, ans);
    if (!diffs.length && inv.checkOk) {
      pass++;
      report.push('✅ ' + head + '：一致（合計 ' + fmtNum_(inv.total) + '、明細' + inv.items.length + '件、配送料 ' + fmtNum_(inv.shipping) + '）');
    } else {
      report.push('❌ ' + head + '：\n   ' + diffs.concat(inv.issues.map(function (s) { return '検算 ' + s; })).join('\n   '));
    }
    if (inv.notes.length) report.push('   メモ：' + inv.notes.join('／'));
  }
  var text = '結果：' + pass + '／' + total + ' 件一致\n' + report.join('\n');
  console.log(text);
  return text;
}

function readTestAnswers_() {
  var sh = ss_().getSheetByName(SHEETS.TEST);
  if (!sh || sh.getLastRow() < 2) throw new Error('「テスト正解」シートに正解がありません');
  var out = {};
  sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {
    var ymd = toYmd_(r[0]);
    if (!ymd) return;
    out[ymd] = {
      total: toNum_(r[1]),
      shipping: toNum_(r[2]),
      items: String(r[3]).split(/[;；]/).map(function (s) { return s.trim(); }).filter(String).map(function (s) {
        var m = s.match(/^(.+?)=([\d.]+):([\d.]+)$/);
        return m ? { name: m[1].trim(), qty: Number(m[2]), amount: Number(m[3]) } : { name: s, qty: null, amount: null };
      })
    };
  });
  return out;
}

/** 正解との違いを文字の配列で返す（空なら一致） */
function compareWithAnswer_(inv, ans) {
  var d = [];
  if (inv.total !== ans.total) d.push('合計 ' + fmtNum_(inv.total) + '（正解 ' + fmtNum_(ans.total) + '）');
  if ((inv.shipping || 0) !== (ans.shipping || 0)) d.push('配送料 ' + fmtNum_(inv.shipping) + '（正解 ' + fmtNum_(ans.shipping) + '）');
  var used = {};
  ans.items.forEach(function (a) {
    var hit = null;
    inv.items.forEach(function (it, i) { if (!hit && !used[i] && it.stdName === a.name) { hit = it; used[i] = true; } });
    if (!hit) { d.push(a.name + '：読み取れていない（品目マスタと照合できなかった可能性）'); return; }
    if (Math.abs(hit.qty - a.qty) > 1e-9) d.push(a.name + '：数量 ' + hit.qty + '（正解 ' + a.qty + '、原文「' + hit.qtyRaw + '」）');
    if (hit.amount !== a.amount) d.push(a.name + '：金額 ' + fmtNum_(hit.amount) + '（正解 ' + fmtNum_(a.amount) + '）');
  });
  inv.items.forEach(function (it, i) { if (!used[i]) d.push('正解にない明細：' + it.nameRaw + '（' + (it.stdName || '未登録') + '）'); });
  return d;
}

/** 「テスト正解」シートを作る（なければ） */
function ensureTestSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName(SHEETS.TEST) || ss.insertSheet(SHEETS.TEST);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS[SHEETS.TEST].length).setValues([HEADERS[SHEETS.TEST]]).setFontWeight('bold').setBackground('#EEEEEE');
    sh.getRange('A:A').setNumberFormat('yyyy-mm-dd');
    sh.setFrozenRows(1);
  }
  return sh;
}
