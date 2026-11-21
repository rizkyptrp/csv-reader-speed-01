// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference CSV reader).
//
// Returns exactly what csv-reader returns for {text, header} -> {columns, rows, errors}:
// a U+FEFF at the very start is dropped; a record ends at LF or CRLF and a line left with no
// characters is no record; outside quotes a CR not followed by LF is dropped (stray_cr); a field
// that opens with a quote runs to the next quote that is not doubled ("" inside it is one quote,
// each CRLF or lone CR inside it reads as LF); what follows its closing quote, up to the next
// comma or line break, is appended as it stands (quote_junk, when the field ends); a quote that
// never closes is a literal character and the text after it is read again as unquoted
// (unterminated_quote); a quote inside an unquoted field is a literal character; fields stay
// strings, never trimmed or converted; rows are padded (short_row) or cut (long_row) to the first
// record's width; each error is {code, line, row} in the order met, line the 1-based line its
// record starts on, row its record's index in rows (null for the header).
//
// Speed: the reference walks the text one character at a time, building every field with +=.
// This reader instead works in slices. Most records are plain lines (no quote, no stray CR):
// one line is found with indexOf('\n') and split on ',' in a single C++ pass. Records that do
// hold a quote or a stray CR take a careful path driven by two small regexes (/[,\r\n]/ and
// /["\r\n]/) that each find the next special character in one scan, so the text is never walked
// character by character and never scanned twice over the same stretch. Everything is pure and
// deterministic: no clock, no randomness, no state kept between calls.

const UNQ = /[,\r\n]/g; // the next thing that can end an unquoted field
const QD = /["\r\n]/g; // the next thing that can end a quoted field's run

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function pushErr(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `init` up to the next comma or line break: a CR not followed
  // by LF is dropped (stray_cr). Returns the field, how it ended, and how many characters kept.
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    for (;;) {
      UNQ.lastIndex = pos;
      const m = UNQ.exec(text);
      if (m === null) {
        if (pos < n) {
          value += text.slice(pos);
          added += n - pos;
        }
        pos = n;
        return { value, ended: END, added };
      }
      const i = m.index;
      const c = m[0];
      if (c === ',') {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 1;
        return { value, ended: COMMA, added };
      }
      if (c === '\n') {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // A CR: a line break with the LF that follows it, else a dropped stray CR.
      if (i + 1 < n && text.charCodeAt(i + 1) === 10) {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      pushErr('stray_cr');
      if (i > pos) {
        value += text.slice(pos, i);
        added += i - pos;
      }
      pos = i + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    for (;;) {
      QD.lastIndex = pos;
      const m = QD.exec(text);
      if (m === null) {
        // The quote never closes: it is a literal character, and the text after it is read
        // again as an unquoted field.
        pos = open + 1;
        line = openLine;
        pushErr('unterminated_quote');
        return readUnquoted('"');
      }
      const i = m.index;
      const c = m[0];
      if (c === '"') {
        if (i + 1 < n && text.charCodeAt(i + 1) === 34) {
          value += text.slice(pos, i);
          value += '"';
          pos = i + 2;
          continue;
        }
        value += text.slice(pos, i);
        pos = i + 1;
        if (pos >= n) return { value, ended: END, added: 0 };
        const d = text.charCodeAt(pos);
        if (d === 44) {
          pos += 1;
          return { value, ended: COMMA, added: 0 };
        }
        if (d === 10) {
          pos += 1;
          line += 1;
          return { value, ended: LINE_BREAK, added: 0 };
        }
        if (d === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          return { value, ended: LINE_BREAK, added: 0 };
        }
        // What follows the closing quote is appended as it stands, up to the next comma or
        // line break.
        const junk = readUnquoted(value);
        if (junk.added > 0) pushErr('quote_junk');
        return junk;
      }
      // CRLF and a lone CR inside quotes are each one LF.
      value += text.slice(pos, i);
      value += '\n';
      line += 1;
      pos = i + (c === '\r' && i + 1 < n && text.charCodeAt(i + 1) === 10 ? 2 : 1);
    }
  }

  // Takes a record's fields: the header, or a row padded or cut to the first record's width.
  function commit(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record's line holds no quote, so no field of it can span a line, and no
    // stray CR, so every field is one slice between commas. A line is plain when it holds no
    // '"' at all and its only CR, if any, is the one of its CRLF ending (a trailing CR with no
    // LF after it is a stray CR at the end of the text, and takes the careful path).
    const iN = text.indexOf('\n', pos);
    const lineEnd = iN === -1 ? n : iN;
    const lineStr = text.slice(pos, lineEnd);
    if (lineStr.indexOf('"') === -1) {
      const r = lineStr.indexOf('\r');
      if (r === -1 || (r === lineStr.length - 1 && iN !== -1)) {
        const fields = r === -1 ? lineStr.split(',') : lineStr.slice(0, -1).split(',');
        pos = iN === -1 ? n : iN + 1;
        if (iN !== -1) line += 1;
        // A line that held only stray CRs is left with no characters: no record. (On this path
        // that is only the empty line, which the skip above already took; kept for safety.)
        if (fields.length === 1 && fields[0] === '') continue;
        commit(fields);
        continue;
      }
    }

    // Careful path: a quoted field, a stray CR, or junk after a closing quote may be in here.
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    commit(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
