/*
 * Normalize.gs / Validate.gs / Tests.gs の比較処理を Node.js で確かめる（Apps Script を使わない部分だけ）。
 *   node invoice-bot/test/run-tests.js
 * 数字は架空のもの（実データは _private に置く）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = {};
vm.createContext(ctx);
['Normalize.gs', 'Validate.gs', 'Tests.gs'].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
});
const g = ctx;

let n = 0;
function test(name, fn) {
  try { fn(); n++; console.log('ok  ' + name); }
  catch (e) { console.error('NG  ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

const master = [
  { std: '品目A', thai: 'ผักเอ', unit: 'kg', aliases: [] },
  { std: '品目B', thai: 'ผักบี', unit: 'kg', aliases: ['ผักบี 50-60g/ชิ้น'] },
  { std: '品目C', thai: 'ใบซี', unit: '枚', aliases: [] }
];

test('仏暦2桁の年を西暦に', () => {
  assert.strictEqual(g.parseThaiDate_('30-10-69', '2026-11-01'), '2026-10-30');
  assert.strictEqual(g.parseThaiDate_('3/1/2570', '2027-01-05'), '2027-01-03');
  assert.strictEqual(g.parseThaiDate_('๓๐-๑๐-๖๙', '2026-11-01'), '2026-10-30');
  assert.strictEqual(g.parseThaiDate_('27/10/2026', '2026-11-01'), '2026-10-27');
  assert.strictEqual(g.parseThaiDate_('', '2026-11-01'), null);
  assert.strictEqual(g.parseThaiDate_('31-02-69', '2026-11-01'), null);
});

test('数量の候補', () => {
  assert.deepStrictEqual(Array.from(g.qtyCandidates_('05')), [5, 0.5]);
  assert.deepStrictEqual(Array.from(g.qtyCandidates_('1.1')), [1.1]);
  assert.deepStrictEqual(Array.from(g.qtyCandidates_('11')), [11, 1.1]);
});

test('数量：単価×数量＝金額で 0.5 を選ぶ（切り上げ・切り捨て）', () => {
  assert.strictEqual(g.chooseQty_('05', 5, 35, 18, 1).qty, 0.5);   // 17.5→18
  assert.strictEqual(g.chooseQty_('1.1', 1.1, 35, 38, 1).qty, 1.1); // 38.5→38
  assert.strictEqual(g.chooseQty_('500', 500, 2, 1000, 1).qty, 500);
  assert.strictEqual(g.chooseQty_('06', null, 35, 21, 1).qty, 0.6);
});

test('品目マスタとの照合', () => {
  assert.strictEqual(g.matchItem_('ผักบี 50-60g/ชิ้น', null, master).std, '品目B');
  assert.strictEqual(g.matchItem_('ผัก เอ', null, master).std, '品目A');
  assert.strictEqual(g.matchItem_('ไม่รู้จัก', '品目C', master).std, '品目C');
  assert.strictEqual(g.matchItem_('ไม่รู้จัก', '存在しない', master), null);
});

function aiSample(over) {
  return Object.assign({
    document_type: 'invoice', document_type_reason: '', supplier_name: 'x', bill_to: 'y',
    date_raw: '28-10-69', date: '2026-10-28', invoice_no: null, subtotal: null, vat: null, shipping: 100, total: 1213,
    items: [
      { name_raw: 'ผักเอ', qty_raw: '05', qty: 5, unit_price: 35, amount: 18, matched_name: null },
      { name_raw: 'ผักบี 50-60g/ชิ้น', qty_raw: '2', qty: 2, unit_price: 47.5, amount: 95, matched_name: null },
      { name_raw: 'ใบซี', qty_raw: '500', qty: 500, unit_price: 2, amount: 1000, matched_name: null }
    ],
    notes: ''
  }, over || {});
}
const optFix = { tolerance: 1, allowFix: true, defaultShipping: 100, vatRate: 0, receivedYmd: '2026-10-29', maxDays: 45 };

test('伝票：正しく読めたもの → 未確認・検算OK', () => {
  const inv = g.normalizeInvoice_(aiSample(), master, { receivedYmd: '2026-10-29', tolerance: 1 });
  g.validateInvoice_(inv, optFix);
  assert.strictEqual(inv.date, '2026-10-28');
  assert.strictEqual(inv.items[0].qty, 0.5);
  assert.strictEqual(inv.itemsSum, 1113);
  assert.ok(inv.checkOk, inv.issues.join('/'));
  assert.strictEqual(inv.status, '未確認');
});

test('配送料の読み違い（100→700）を合計から逆算して直す', () => {
  const inv = g.normalizeInvoice_(aiSample({ shipping: 700 }), master, { receivedYmd: '2026-10-29', tolerance: 1 });
  g.validateInvoice_(inv, optFix);
  assert.strictEqual(inv.shipping, 100);
  assert.ok(inv.checkOk);
  assert.ok(inv.notes.some(s => s.indexOf('逆算') >= 0));
});

test('配送料が明細に入っていたら配送料の欄へ移す', () => {
  const ai = aiSample({ shipping: null });
  ai.items.push({ name_raw: 'ค่ารถ', qty_raw: null, qty: null, unit_price: null, amount: 100, matched_name: null });
  const inv = g.normalizeInvoice_(ai, master, { receivedYmd: '2026-10-29', tolerance: 1 });
  g.validateInvoice_(inv, optFix);
  assert.strictEqual(inv.items.length, 3);
  assert.strictEqual(inv.shipping, 100);
  assert.ok(inv.checkOk);
});

test('金額の読み違い → 要確認', () => {
  const ai = aiSample({ total: 1303 });
  ai.items[2].amount = 1090;
  const inv = g.normalizeInvoice_(ai, master, { receivedYmd: '2026-10-29', tolerance: 1 });
  g.validateInvoice_(inv, optFix);
  assert.ok(!inv.checkOk);
  assert.strictEqual(inv.status, '要確認');
});

test('日付が受信日から離れている → 要確認', () => {
  const inv = g.normalizeInvoice_(aiSample({ date_raw: '28-01-69' }), master, { receivedYmd: '2026-10-29', tolerance: 1 });
  g.validateInvoice_(inv, optFix);
  assert.ok(inv.issues.some(s => s.indexOf('離れている') >= 0));
});

test('VAT率の確認（注意のみ）', () => {
  const inv = g.normalizeInvoice_(aiSample({ vat: 70, total: 1283 }), master, { receivedYmd: '2026-10-29', tolerance: 1 });
  g.validateInvoice_(inv, Object.assign({}, optFix, { vatRate: 7 }));
  assert.ok(inv.checkOk);
  assert.ok(inv.warnings.length === 1);
  assert.strictEqual(inv.status, '要確認');
});

test('単価の変動 ±20%', () => {
  const hist = [
    { name: '品目A', date: '2026-10-20', price: 35 },
    { name: '品目A', date: '2026-10-25', price: 35 }
  ];
  const a = g.computePriceAlerts_([{ stdName: '品目A', price: 45 }], hist, '2026-10-28', 5, 20);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(g.formatAlert_(a[0]), '⚠ 品目A 35→45（+29%）');
  assert.strictEqual(g.computePriceAlerts_([{ stdName: '品目A', price: 40 }], hist, '2026-10-28', 5, 20).length, 0);
});

test('重複判定', () => {
  const ex = [{ id: 'S01-20261028-1', supplierId: 'S01', date: '2026-10-28', invoiceNo: '', total: 1213, hash: 'h1' }];
  assert.ok(g.findDuplicate_(ex, 'S01', { invoiceNo: '', date: '2026-10-28', total: 1213 }, ''));
  assert.ok(g.findDuplicate_(ex, 'S02', { invoiceNo: '', date: '', total: null }, 'h1'));
  assert.strictEqual(g.findDuplicate_(ex, 'S01', { invoiceNo: '', date: '2026-10-28', total: 1300 }, ''), null);
  assert.strictEqual(g.findDuplicate_(ex, 'S02', { invoiceNo: '', date: '2026-10-28', total: 1213 }, ''), null);
});

test('正解との比較', () => {
  const inv = g.normalizeInvoice_(aiSample(), master, { receivedYmd: '2026-10-29', tolerance: 1 });
  const ans = { total: 1213, shipping: 100, items: [{ name: '品目A', qty: 0.5, amount: 18 }, { name: '品目B', qty: 2, amount: 95 }, { name: '品目C', qty: 500, amount: 1000 }] };
  assert.deepStrictEqual(Array.from(g.compareWithAnswer_(inv, ans)), []);
  ans.items[0].qty = 5;
  assert.strictEqual(g.compareWithAnswer_(inv, ans).length, 1);
});

console.log(n + ' 件のテストが通りました');
