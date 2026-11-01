/**
 * Claude.gs — 画像・PDFを Claude API に直接渡して読み取る
 *
 * PDFのタイ語は文字として取り出すと崩れるので、テキスト抽出はせず PDF のまま渡す。
 */

var CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
var CLAUDE_DEFAULT_MODEL = 'claude-opus-5-5';
/* 安全上の理由で断られたときに、別のモデルで自動的にやり直す設定（fallbacks）が使えるモデル */
var CLAUDE_FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'];
var CLAUDE_MAX_IMAGE_BYTES = 3700000; // base64 にすると約5MB（画像1枚の上限）

var CLAUDE_SYSTEM = [
  'あなたはタイにある日本食レストラン「おにまる」の経理担当です。仕入先から届いた書類（写真またはPDF）を読み取り、指定のJSONだけを返します。',
  '',
  '# 1. 書類の種類（document_type）',
  '- invoice：支払いを求める請求書・納品請求書。例：CASH SALE / บิลเงินสด / ใบแจ้งหนี้ / ใบกำกับภาษี / ใบส่งของ（金額と合計があるもの）/ INVOICE',
  '- quotation：見積書（ใบเสนอราคา / QUOTATION）',
  '- payment_proof：送金・支払いの証明（銀行アプリの画面、スリップ、QR決済の画面）',
  '- other：上記以外（商品の写真、メモ、その他）',
  'invoice 以外のときは、items を空にし、数値はすべて null にしてよい。document_type_reason に判断理由を短く書く。',
  '',
  '# 2. 読み取りのルール（invoice のとき）',
  '- 品目名（name_raw）は書かれたとおりに写す（タイ語のまま。翻訳しない）。',
  '- 数量の原文（qty_raw）は書かれた文字のまま写す。手書きの「05」「06」は先頭の0も残す。',
  '- 数量（qty）はあなたの解釈。手書きでは「05」は 0.5、「06」は 0.6 を意味することが多い。小数点の書き方は一定しないので、qty × unit_price ≒ amount（±1バーツ。端数は切り上げ・切り捨てどちらもある）になるように判断する。',
  '- 単価（unit_price）と金額（amount）は数字のみ。読めない数字は null。推測で埋めない。',
  '- 配送料（ค่ารถ / ค่าส่ง / ค่าขนส่ง / delivery）は items に入れず shipping に入れる。',
  '- VAT（ภาษีมูลค่าเพิ่ม / VAT 7%）は vat に、税抜きの小計があれば subtotal に入れる。なければ null。',
  '- total は伝票の合計（รวมเงิน / รวมทั้งสิ้น / TOTAL）。',
  '- 読みにくい数字（例：「150」と「750」）は、明細の合計＋配送料（＋VAT）＝合計 になるほうを選ぶ。',
  '- 伝票番号（invoice_no）は空欄なら null。',
  '- 日付：date_raw には書かれたとおり（例 30-10-69）。date には西暦の YYYY-MM-DD。タイの伝票は「日-月-年」で、年は仏暦が多い（2569年＝西暦2026年、「69」は仏暦2569の略）。',
  '- bill_to は宛先（店名など）、supplier_name は発行元の店名・会社名。',
  '- matched_name：品目マスタ（ユーザーのメッセージに一覧がある）と同じ品物なら、その「日本語名」をそのまま入れる。該当しなければ null。',
  '- notes：読み取りに自信がない箇所、書き直し・消し線などがあれば日本語で短く書く。なければ空文字。'
].join('\n');

var INVOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['document_type', 'document_type_reason', 'supplier_name', 'bill_to', 'date_raw', 'date', 'invoice_no', 'subtotal', 'vat', 'shipping', 'total', 'items', 'notes'],
  properties: {
    document_type: { type: 'string', enum: ['invoice', 'quotation', 'payment_proof', 'other'] },
    document_type_reason: { type: 'string' },
    supplier_name: { type: ['string', 'null'] },
    bill_to: { type: ['string', 'null'] },
    date_raw: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    invoice_no: { type: ['string', 'null'] },
    subtotal: { type: ['number', 'null'] },
    vat: { type: ['number', 'null'] },
    shipping: { type: ['number', 'null'] },
    total: { type: ['number', 'null'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name_raw', 'qty_raw', 'qty', 'unit_price', 'amount', 'matched_name'],
        properties: {
          name_raw: { type: 'string' },
          qty_raw: { type: ['string', 'null'] },
          qty: { type: ['number', 'null'] },
          unit_price: { type: ['number', 'null'] },
          amount: { type: ['number', 'null'] },
          matched_name: { type: ['string', 'null'] }
        }
      }
    },
    notes: { type: 'string' }
  }
};

var DOC_TYPE_LABEL = { invoice: '請求書', quotation: '見積書', payment_proof: '送金証明', other: 'その他' };

/**
 * 書類を読み取る。
 * file: { blob, fileId }  fileId はドライブに保存したファイル（大きい画像を縮小するときに使う）
 */
function claudeReadInvoice_(file, supplier, master, receivedYmd) {
  var key = prop_('ANTHROPIC_API_KEY');
  if (!key) throw new Error('スクリプトプロパティ ANTHROPIC_API_KEY が未設定です');
  var model = prop_('CLAUDE_MODEL') || CLAUDE_DEFAULT_MODEL;
  var effort = prop_('CLAUDE_EFFORT') || 'medium';

  var payload = {
    model: model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: effort, format: { type: 'json_schema', schema: INVOICE_SCHEMA } },
    system: CLAUDE_SYSTEM,
    messages: [{
      role: 'user',
      content: [fileBlock_(file), { type: 'text', text: buildUserText_(supplier, master, receivedYmd) }]
    }]
  };
  var useFallback = CLAUDE_FALLBACK_MODELS.indexOf(model) >= 0;
  if (useFallback) payload.fallbacks = 'default';

  var res = claudeCall_(key, payload, useFallback);
  if (res.code === 400) {
    // 古いモデルなどで指定が通らないときは、出力形式の指定と fallbacks を外してもう一度
    console.warn('Claude API 400。指定を減らして再試行します: ' + res.body.slice(0, 500));
    delete payload.fallbacks;
    delete payload.output_config.format;
    res = claudeCall_(key, payload, false);
  }
  if (res.code !== 200) throw new Error('Claude API エラー ' + res.code + '：' + res.body.slice(0, 500));

  var data = JSON.parse(res.body);
  if (data.stop_reason === 'refusal') throw new Error('Claude が読み取りを断りました（refusal）');
  if (data.stop_reason === 'max_tokens') throw new Error('Claude の出力が途中で切れました（max_tokens）');
  var text = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  var json = parseJsonLoose_(text);
  json.items = json.items || [];
  return json;
}

function claudeCall_(key, payload, withFallbackBeta) {
  var headers = { 'x-api-key': key, 'anthropic-version': '2026-10-21' };
  if (withFallbackBeta) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  var r = UrlFetchApp.fetch(CLAUDE_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return { code: r.getResponseCode(), body: r.getContentText() };
}

function buildUserText_(supplier, master, receivedYmd) {
  var lines = [];
  lines.push('仕入先（設定上の名前）：' + supplier.name);
  lines.push('受信日：' + receivedYmd + '（伝票の日付はふつう受信日以前の数日以内）');
  if (supplier.defaultShipping) lines.push('この仕入先の配送料はふつう ' + supplier.defaultShipping + ' バーツ');
  if (supplier.vatRate) lines.push('この仕入先は VAT ' + supplier.vatRate + '% が別にかかる');
  lines.push('');
  lines.push('品目マスタ（日本語名｜タイ語名｜別名）：');
  if (!master.length) lines.push('（なし）');
  master.forEach(function (m) {
    lines.push('- ' + m.std + '｜' + (m.thai || '') + '｜' + (m.aliases || []).join(', '));
  });
  lines.push('');
  lines.push('この書類を読み取り、指定のJSONだけを返してください。');
  return lines.join('\n');
}

function fileBlock_(file) {
  var blob = file.blob;
  var ct = String(blob.getContentType() || '').toLowerCase();
  var bytes = blob.getBytes();
  var isPdf = ct === 'application/pdf' || isPdfBytes_(bytes);
  if (isPdf) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Utilities.base64Encode(bytes) } };
  }
  if (ct === 'image/jpg') ct = 'image/jpeg';
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].indexOf(ct) < 0) ct = 'image/jpeg';
  if (bytes.length > CLAUDE_MAX_IMAGE_BYTES) {
    if (!file.fileId) throw new Error('画像が大きすぎます（' + Math.round(bytes.length / 1e6) + 'MB）');
    var small = shrinkViaDrive_(file.fileId);
    bytes = small.getBytes();
    ct = small.getContentType() || 'image/jpeg';
  }
  return { type: 'image', source: { type: 'base64', media_type: ct, data: Utilities.base64Encode(bytes) } };
}

function isPdfBytes_(bytes) {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

/** 大きすぎる画像は、ドライブの縮小画像（長辺2000px）を使う */
function shrinkViaDrive_(fileId) {
  var auth = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  var meta = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=thumbnailLink', { headers: auth, muteHttpExceptions: true });
  var link = meta.getResponseCode() === 200 ? JSON.parse(meta.getContentText()).thumbnailLink : '';
  if (!link) throw new Error('画像が大きく、縮小画像もまだ作られていません（次の回で再試行します）');
  var r = UrlFetchApp.fetch(link.replace(/=s\d+$/, '=s2000'), { headers: auth, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('縮小画像を取得できません：' + r.getResponseCode());
  return r.getBlob();
}

/** ```json … ``` や前後の文章が付いていても JSON を取り出す */
function parseJsonLoose_(text) {
  var s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch (e) { /* 下で再挑戦 */ }
  var a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('Claude の返答がJSONではありません：' + s.slice(0, 200));
}
