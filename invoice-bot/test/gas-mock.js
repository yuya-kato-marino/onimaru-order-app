/*
 * Apps Script の一部（SpreadsheetApp・DriveApp・UrlFetchApp など）を Node.js でまねる。
 * 通し試験（run-flow-test.js）用。本物の動きを完全には再現しない。
 */
const crypto = require('crypto');

function colToNum(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

class Blob {
  constructor(bytes, type, name) { this.bytes = Buffer.from(bytes); this.type = type; this.name = name || ''; }
  getBytes() { return Array.from(this.bytes).map(b => (b > 127 ? b - 256 : b)); }
  getContentType() { return this.type; }
  copyBlob() { return new Blob(this.bytes, this.type, this.name); }
  setName(n) { this.name = n; return this; }
  getDataAsString() { return this.bytes.toString('utf8'); }
}

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) {
        const v = (this.sheet.data[this.r - 1 + i] || [])[this.c - 1 + j];
        row.push(v === undefined || v === null ? '' : v);
      }
      out.push(row);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    vals.forEach((row, i) => row.forEach((v, j) => this.sheet.put(this.r + i, this.c + j, v)));
    return this;
  }
  setValue(v) { this.sheet.put(this.r, this.c, v); return this; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.put(this.r + i, this.c + j, ''); return this; }
  insertCheckboxes() { for (let i = 0; i < this.nr; i++) if ((this.sheet.data[this.r - 1 + i] || [])[this.c - 1] === undefined) this.sheet.put(this.r + i, this.c, false); return this; }
  setFontWeight() { return this; } setBackground() { return this; } setNumberFormat() { return this; } setDataValidation() { return this; }
}

class Sheet {
  constructor(name, id) { this.name = name; this.id = id; this.data = []; }
  put(r, c, v) {
    while (this.data.length < r) this.data.push([]);
    if (typeof v === 'string' && v.charAt(0) === "'") v = v.slice(1);
    this.data[r - 1][c - 1] = v;
  }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) if ((this.data[i] || []).some(v => v !== '' && v !== undefined && v !== null)) return i + 1;
    return 0;
  }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(a, b, c, d) {
    if (typeof a === 'string') { const m = a.match(/^([A-Z]+)/); return new Range(this, 1, colToNum(m[1]), 1, 1); }
    return new Range(this, a, b, c || 1, d || 1);
  }
  appendRow(row) { const r = this.getLastRow() + 1; row.forEach((v, j) => this.put(r, j + 1, v)); }
  setFrozenRows() {}
  clear() { this.data = []; }
}

function makeEnv(opts) {
  const props = {};
  const sheets = [];
  let sheetSeq = 0;
  const ss = {
    getId: () => 'SS1', getUrl: () => 'https://docs.google.com/spreadsheets/d/SS1/edit', getName: () => 'テスト用',
    getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet: n => { const s = new Sheet(n, ++sheetSeq); sheets.push(s); return s; },
    getSheets: () => sheets.slice(),
    deleteSheet: s => sheets.splice(sheets.indexOf(s), 1),
    setSpreadsheetTimeZone() {}
  };
  ss.insertSheet('シート1');

  const files = {};
  let fileSeq = 0;
  function folder(name) {
    const children = {};
    return {
      name,
      getId: () => 'FOLDER_' + name,
      getFoldersByName: n => { let used = false; return { hasNext: () => !used && !!children[n], next: () => { used = true; return children[n]; } }; },
      createFolder: n => (children[n] = folder(n)),
      createFile: blob => {
        const id = 'F' + (++fileSeq);
        const f = { getId: () => id, getUrl: () => 'https://drive.google.com/file/d/' + id + '/view', getBlob: () => blob.copyBlob(), getMimeType: () => blob.type, getName: () => blob.name, getDateCreated: () => new Date() };
        files[id] = f;
        return f;
      }
    };
  }
  const root = folder('root');

  const sent = { push: [], reply: [] };
  const lineContent = {};    // messageId → Blob
  const claudeAnswers = [];  // 順に返す
  const claudeRequests = [];

  const env = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss, openById: () => ss, flush() {},
      newDataValidation: () => ({ requireValueInList() { return this; }, build() { return {}; } })
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => { const m = {}; return { get: k => (k in m ? m[k] : null), put: (k, v) => { m[k] = v; } }; } },
    ScriptApp: {
      triggers: [],
      getProjectTriggers() { return this.triggers; },
      deleteTrigger(t) { this.triggers.splice(this.triggers.indexOf(t), 1); },
      newTrigger(fn) { const self = this; return { timeBased: () => ({ everyMinutes: () => ({ create: () => { self.triggers.push({ getHandlerFunction: () => fn }); } }) }) }; },
      getOAuthToken: () => 'tok'
    },
    DriveApp: { createFolder: n => root.createFolder(n), getFolderById: () => root, getFileById: id => files[id] },
    ContentService: { createTextOutput: t => ({ setMimeType() { return t; } }), MimeType: { JSON: 'json' } },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, bytes) => Array.from(crypto.createHash('sha256').update(Buffer.from(bytes.map(b => b & 255))).digest()).map(b => (b > 127 ? b - 256 : b)),
      base64Encode: bytes => Buffer.from(bytes.map(b => b & 255)).toString('base64'),
      formatDate: (d, tz, fmt) => {
        // TZ=Asia/Bangkok で動かす前提
        const p = n => String(n).padStart(2, '0');
        return fmt.replace('yyyy', d.getFullYear()).replace('MM', p(d.getMonth() + 1)).replace('dd', p(d.getDate()))
          .replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes())).replace('ss', p(d.getSeconds()));
      }
    },
    UrlFetchApp: {
      fetch(url, opt) {
        opt = opt || {};
        const resp = (code, body, blob) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)), getBlob: () => blob });
        let m;
        if ((m = url.match(/api-data\.line\.me\/v2\/bot\/message\/(\w+)\/content/))) {
          return lineContent[m[1]] ? resp(200, '', lineContent[m[1]].copyBlob()) : resp(404, 'not found');
        }
        if (/\/message\/push$/.test(url)) { sent.push.push(JSON.parse(opt.payload)); return resp(200, '{}'); }
        if (/\/message\/reply$/.test(url)) { sent.reply.push(JSON.parse(opt.payload)); return resp(200, '{}'); }
        if (/\/group\/\w+\/summary$/.test(url)) return resp(200, { groupName: '八百屋グループ' });
        if (/\/group\/\w+\/member\/\w+$/.test(url)) return resp(200, { displayName: '業者さん' });
        if (/\/v2\/bot\/info$/.test(url)) return resp(200, { userId: 'UBOT' });
        if (/api\.anthropic\.com/.test(url)) {
          const req = JSON.parse(opt.payload);
          claudeRequests.push({ req, headers: opt.headers });
          const a = claudeAnswers.shift();
          if (!a) return resp(500, 'no canned answer');
          return resp(200, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(a) }] });
        }
        return resp(404, 'unknown ' + url);
      }
    }
  };
  return { env, ss, props, sent, lineContent, claudeAnswers, claudeRequests, Blob };
}

module.exports = { makeEnv, Blob };
