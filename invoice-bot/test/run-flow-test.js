/*
 * 通し試験：受信 → キュー → 読み取り（Claude はまね）→ 記録 → 報告 → OK → 月次集計
 *   node invoice-bot/test/run-flow-test.js
 * 数字は架空のもの。
 */
process.env.TZ = 'Asia/Bangkok';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { makeEnv } = require('./gas-mock');

const t = makeEnv();
const ctx = vm.createContext(Object.assign({}, t.env));
fs.readdirSync(path.join(__dirname, '..', 'gas')).filter(f => f.endsWith('.gs')).forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
});
const run = code => vm.runInContext(code, ctx);
const table = name => t.ss.getSheetByName(name).data;
const col = (name, h) => table(name)[0].indexOf(h);

let n = 0;
function step(name, fn) {
  try { fn(); n++; console.log('ok  ' + name); }
  catch (e) { console.error('NG  ' + name + '\n    ' + (e.stack || e.message)); process.exitCode = 1; }
}

t.props.LINE_CHANNEL_ACCESS_TOKEN = 'line-token';
t.props.ANTHROPIC_API_KEY = 'sk-test';
t.props.WEBHOOK_KEY = 'abc';

step('setup：シート・設定・トリガー', () => {
  run('setup()');
  ['伝票', '明細', '月次集計', '単価履歴', '品目マスタ', '設定', 'ログ', 'キュー'].forEach(s => assert.ok(t.ss.getSheetByName(s), s));
  assert.ok(!t.ss.getSheetByName('シート1'));
  assert.strictEqual(t.props.BOT_USER_ID, 'UBOT');
  assert.strictEqual(t.env.ScriptApp.triggers.length, 1);
  // 設定：八百屋のグループと送信者、報告の送り先
  const s = t.ss.getSheetByName('設定');
  s.put(2, 4, 'CGROUP1'); s.put(2, 5, 'USUP1'); s.put(2, 7, 100); s.put(2, 13, 'UKATO');
  // テスト用の品目マスタ（架空）
  const m = t.ss.getSheetByName('品目マスタ');
  m.data = [m.data[0]];
  m.appendRow(['S01', '品目A', 'ผักเอ', 'kg', '', '', '']);
  m.appendRow(['S01', '品目C', 'ใบซี', '枚', '', '', '']);
});

function post(events, key) {
  return run('doPost(' + JSON.stringify({ parameter: { key: key === undefined ? 'abc' : key }, postData: { contents: JSON.stringify({ destination: 'UBOT', events }) } }) + ')');
}
function imageEvent(id, group, user, ts) {
  return { type: 'message', webhookEventId: 'E' + id, timestamp: ts || Date.parse('2026-10-28T10:00:00+07:00'), source: { type: 'group', groupId: group, userId: user }, replyToken: 'r', message: { type: 'image', id } };
}
function ai(over) {
  return Object.assign({
    document_type: 'invoice', document_type_reason: '', supplier_name: 'x', bill_to: 'y',
    date_raw: '28-10-69', date: '2026-10-28', invoice_no: null, subtotal: null, vat: null, shipping: 700, total: 1118,
    items: [
      { name_raw: 'ผักเอ', qty_raw: '05', qty: 5, unit_price: 35, amount: 18, matched_name: null },
      { name_raw: 'ใบซี', qty_raw: '500', qty: 500, unit_price: 2, amount: 1000, matched_name: null }
    ],
    notes: ''
  }, over || {});
}

step('検証（イベントなし）と鍵違い', () => {
  post([]);
  post([imageEvent('m0', 'CGROUP1', 'USUP1')], 'wrong');
  const log = table('ログ');
  assert.ok(log.some(r => r[1] === '検証'));
  assert.ok(log.some(r => r[7] === '拒否'));
  assert.strictEqual(t.ss.getSheetByName('キュー').getLastRow(), 1);
});

step('受信 → キュー（再送は重複させない）', () => {
  t.lineContent.m1 = new t.Blob([1, 2, 3, 4], 'image/jpeg');
  t.lineContent.m2 = new t.Blob([9, 9, 9], 'image/jpeg');
  t.lineContent.m3 = new t.Blob([5, 5, 5], 'image/jpeg');
  post([imageEvent('m1', 'CGROUP1', 'USUP1'), imageEvent('m2', 'CGROUP1', 'USTAFF'), imageEvent('m3', 'COTHER', 'USUP1')]);
  post([imageEvent('m1', 'CGROUP1', 'USUP1')]);
  post([{ type: 'message', source: { type: 'group', groupId: 'CGROUP1', userId: 'USUP1' }, message: { type: 'text', id: 't1', text: 'hello' } }]);
  post([{ type: 'join', source: { type: 'group', groupId: 'CGROUP9' } }]);
  assert.strictEqual(t.ss.getSheetByName('キュー').getLastRow(), 4);
  assert.ok(table('ログ').some(r => r[1] === '参加' && r[2] === 'CGROUP9' && r[3] === '八百屋グループ'));
});

step('キュー処理：判定・読み取り・記録・報告（配送料の補正、0.5）', () => {
  t.claudeAnswers.push(ai());
  run('processQueue()');
  const q = table('キュー');
  const st = q.slice(1).map(r => r[col('キュー', '状態')]);
  assert.deepStrictEqual(st, ['記録', 'スキップ', 'スキップ']);
  assert.ok(q[2][col('キュー', '備考')].indexOf('登録外の送信者') >= 0);
  assert.ok(q[3][col('キュー', '備考')].indexOf('未登録のグループ') >= 0);

  const inv = table('伝票');
  assert.strictEqual(inv.length, 2);
  const r = inv[1];
  assert.strictEqual(r[col('伝票', '伝票ID')], 'S01-20261028-1');
  assert.strictEqual(r[col('伝票', '配送料')], 100);
  assert.strictEqual(r[col('伝票', '合計')], 1118);
  assert.strictEqual(r[col('伝票', '状態')], '未確認');
  const lines = table('明細');
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[1][col('明細', '数量')], 0.5);
  assert.strictEqual(lines[1][col('明細', '品目（標準名）')], '品目A');
  assert.strictEqual(lines[1][col('明細', '単位')], 'kg');
  assert.strictEqual(lines[1][col('明細', '数量（原文）')], '05');

  // Claude へのリクエスト
  const req = t.claudeRequests[0];
  assert.strictEqual(req.req.model, 'claude-opus-5-5');
  assert.strictEqual(req.req.fallbacks, 'default');
  assert.strictEqual(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.strictEqual(req.req.messages[0].content[0].type, 'image');

  // 報告は加藤さんの個別トークだけ。グループには何も送らない
  assert.strictEqual(t.sent.push.length, 1);
  assert.strictEqual(t.sent.push[0].to, 'UKATO');
  const flex = t.sent.push[0].messages[0];
  const texts = flex.contents.body.contents.map(c => c.text);
  console.log('    報告：' + texts.join(' / '));
  assert.ok(texts[0].indexOf('10/28') === 0);
  assert.ok(texts.some(s => s.indexOf('合計 1,118バーツ（明細2件＋配送料100）検算OK') >= 0));
  assert.ok(texts.some(s => s === '新規品目なし／単価の大きな変動なし'));
  assert.ok(texts.some(s => s.indexOf('逆算') >= 0));
  assert.strictEqual(flex.contents.footer.contents[0].action.data, 'a=ok&id=S01-20261028-1');
});

step('同じ伝票をもう一度（別の画像）→ 重複の疑い・記録しない', () => {
  t.lineContent.m4 = new t.Blob([7, 7, 7, 7], 'image/jpeg');
  post([imageEvent('m4', 'CGROUP1', 'USUP1')]);
  t.claudeAnswers.push(ai());
  run('processQueue()');
  assert.strictEqual(table('伝票').length, 2);
  assert.ok(t.sent.push[1].messages[0].text.indexOf('重複の疑い') >= 0);
});

step('送金証明 → 記録しない・報告しない', () => {
  t.lineContent.m5 = new t.Blob([8, 8], 'image/jpeg');
  post([imageEvent('m5', 'CGROUP1', 'USUP1')]);
  t.claudeAnswers.push(ai({ document_type: 'payment_proof', document_type_reason: '銀行アプリの送金画面', items: [] }));
  const before = t.sent.push.length;
  run('processQueue()');
  assert.strictEqual(table('伝票').length, 2);
  assert.strictEqual(t.sent.push.length, before);
  assert.ok(table('ログ').some(r => String(r[8]).indexOf('送金証明') >= 0));
});

step('検算NGの伝票 → 要確認、OKを押しても直すまで確認済みにならない', () => {
  t.lineContent.m6 = new t.Blob([6, 6, 6], 'image/jpeg');
  post([imageEvent('m6', 'CGROUP1', 'USUP1', Date.parse('2026-10-30T10:00:00+07:00'))]);
  const a = ai({ date_raw: '30-10-69', date: '2026-10-30', shipping: 100, total: 1170 });
  a.items[1].amount = 1100; // 読み間違い（正しくは1000）
  a.items.push({ name_raw: 'ของใหม่', qty_raw: '1', qty: 1, unit_price: 45, amount: 45, matched_name: null }); // 新規品目
  a.items[0].unit_price = 50; a.items[0].amount = 25; // 単価 35→50（+43%）
  t.claudeAnswers.push(a);
  run('processQueue()');
  const flex = t.sent.push[t.sent.push.length - 1].messages[0];
  const texts = flex.contents.body.contents.map(c => c.text);
  console.log('    報告：' + texts.join(' / '));
  assert.ok(flex.altText.indexOf('【要確認】') === 0);
  assert.ok(texts.some(s => s.indexOf('🆕 新規品目：ของใหม่') >= 0));
  assert.ok(texts.some(s => s.indexOf('⚠ 品目A 35→50（+43%）') >= 0));
  const id = 'S01-20261030-1';
  assert.strictEqual(table('伝票')[2][col('伝票', '状態')], '要確認');

  // 要修正
  post([{ type: 'postback', replyToken: 'rt1', source: { type: 'user', userId: 'UKATO' }, postback: { data: 'a=fix&id=' + id } }]);
  assert.ok(t.sent.reply[0].messages[0].text.indexOf('シートで直して') >= 0);
  // 直さずにOK
  post([{ type: 'postback', replyToken: 'rt2', source: { type: 'user', userId: 'UKATO' }, postback: { data: 'a=ok&id=' + id } }]);
  assert.ok(t.sent.reply[1].messages[0].text.indexOf('確認済みにしていません') >= 0);
  assert.strictEqual(table('伝票')[2][col('伝票', '状態')], '要確認');
  // シートで金額を直してからOK
  const lines = t.ss.getSheetByName('明細');
  const row = lines.data.findIndex(r => r[0] === id && r[5] === 'ใบซี');
  lines.put(row + 1, col('明細', '金額') + 1, 1000);
  post([{ type: 'postback', replyToken: 'rt3', source: { type: 'user', userId: 'UKATO' }, postback: { data: 'a=ok&id=' + id } }]);
  assert.ok(t.sent.reply[2].messages[0].text.indexOf('✅ 確認済み') === 0, t.sent.reply[2].messages[0].text);
  assert.strictEqual(table('伝票')[2][col('伝票', '状態')], '確認済み');
});

step('報告の送り先以外からのボタンは無視', () => {
  const before = t.sent.reply.length;
  post([{ type: 'postback', replyToken: 'rt9', source: { type: 'user', userId: 'USOMEONE' }, postback: { data: 'a=ok&id=S01-20261028-1' } }]);
  assert.strictEqual(t.sent.reply.length, before);
  assert.strictEqual(table('伝票')[1][col('伝票', '状態')], '未確認');
});

step('OK → 月次集計・単価履歴・参考単価', () => {
  post([{ type: 'postback', replyToken: 'rt4', source: { type: 'user', userId: 'UKATO' }, postback: { data: 'a=ok&id=S01-20261028-1' } }]);
  run('processQueue()');
  const sum = table('月次集計');
  const rowsA = sum.slice(2).filter(r => r[0]);
  const total = rowsA.find(r => r[2] === '（総合計）');
  assert.strictEqual(total[0], '2026-10');
  assert.strictEqual(total[3], 2);
  assert.strictEqual(total[7], 1118 + 1170);
  const top = sum[2].slice(11);
  assert.strictEqual(top[1], 1);
  assert.strictEqual(top[3], '品目C');
  assert.strictEqual(top[6], 2000);
  const ph = table('単価履歴');
  assert.ok(ph.length >= 4);
  const m = table('品目マスタ');
  assert.strictEqual(m[1][4], (35 + 50) / 2);
  console.log('    月次：' + rowsA.map(r => r.slice(0, 4).concat(r[7]).join(' ')).join(' | '));
});

step('1対1で「id」→ userId を返す（グループでは発言しない）', () => {
  const before = t.sent.reply.length;
  post([{ type: 'message', replyToken: 'rt5', source: { type: 'user', userId: 'UKATO' }, message: { type: 'text', id: 't2', text: 'ID' } }]);
  assert.ok(t.sent.reply[before].messages[0].text.indexOf('UKATO') >= 0);
  post([{ type: 'message', replyToken: 'rt6', source: { type: 'group', groupId: 'CGROUP1', userId: 'UKATO' }, message: { type: 'text', id: 't3', text: 'id' } }]);
  assert.strictEqual(t.sent.reply.length, before + 1);
});

step('PDF（のりたけ・送信者は誰でも）', () => {
  const s = t.ss.getSheetByName('設定');
  s.put(3, 4, 'CGROUP2');
  t.lineContent.p1 = new t.Blob(Buffer.from('%PDF-1.4 test'), 'application/pdf');
  t.lineContent.p2 = new t.Blob([1], 'image/jpeg');
  post([
    { type: 'message', timestamp: Date.parse('2026-10-31T10:00:00+07:00'), source: { type: 'group', groupId: 'CGROUP2', userId: 'UANY' }, message: { type: 'file', id: 'p1', fileName: 'INV-001.pdf' } },
    { type: 'message', timestamp: Date.parse('2026-10-31T10:00:00+07:00'), source: { type: 'group', groupId: 'CGROUP2', userId: 'UANY' }, message: { type: 'image', id: 'p2' } }
  ]);
  t.claudeAnswers.push({
    document_type: 'invoice', document_type_reason: '', supplier_name: 'Noritake', bill_to: 'Onimaru', date_raw: '31/10/2026', date: '2026-10-31',
    invoice_no: 'IV001', subtotal: 1250, vat: 87.5, shipping: 250, total: 1337.5,
    items: [{ name_raw: 'Tomato', qty_raw: '10', qty: 10, unit_price: 100, amount: 1000, matched_name: null }], notes: ''
  });
  run('processQueue()');
  const q = table('キュー');
  assert.strictEqual(q[q.length - 2][col('キュー', '状態')], '記録');
  assert.ok(q[q.length - 1][col('キュー', '備考')].indexOf('形式が対象外') >= 0);
  assert.strictEqual(t.claudeRequests[t.claudeRequests.length - 1].req.messages[0].content[0].type, 'document');
  const inv = table('伝票');
  const last = inv[inv.length - 1];
  assert.strictEqual(last[col('伝票', '伝票番号')], 'IV001');
  assert.strictEqual(last[col('伝票', '状態')], '未確認');
});

step('Claude のエラー → 再試行 → 3回でエラー通知', () => {
  t.lineContent.m7 = new t.Blob([3, 1, 4], 'image/jpeg');
  post([imageEvent('m7', 'CGROUP1', 'USUP1')]);
  run('processQueue()'); run('processQueue()');
  let q = table('キュー');
  assert.strictEqual(q[q.length - 1][col('キュー', '状態')], '再試行');
  const before = t.sent.push.length;
  run('processQueue()');
  q = table('キュー');
  assert.strictEqual(q[q.length - 1][col('キュー', '状態')], 'エラー');
  assert.ok(t.sent.push[before].messages[0].text.indexOf('失敗しました') >= 0);
});

console.log(n + ' 件の手順が通りました');
