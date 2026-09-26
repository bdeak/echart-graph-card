/**
 * Small YAML subset parser for the dev harness, so the page renders the real examples/*.yaml
 * files (no extra dependency just for the harness).
 *
 * Supported: block mappings and sequences (including `- key: value` compact items and
 * sequences at the same indentation as their parent key), flow collections (`{ a: 1 }`,
 * `[1, 2]`, nested, may span lines), plain / single-quoted / double-quoted scalars, literal
 * and folded block scalars (`|`, `>`, with `-` / `+` chomping), comments, `---` markers.
 * Scalars resolve like YAML 1.2 core: null/~, true/false, ints, floats; everything else is a
 * string.
 *
 * Deliberately strict where HA's YAML loader would reject the file too: tabs in indentation,
 * duplicate keys, anchors/aliases/tags, and plain scalars starting with an indicator character
 * (`%`, `@`, `` ` ``, `&`, `*`, `!`, `|`, `>`) all throw a YamlError with the line number.
 */

export class YamlError extends Error {
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `YAML line ${line}: ${message}`);
    this.name = 'YamlError';
  }
}

interface Line {
  /** 1-based line number. */
  no: number;
  indent: number;
  /** Comment-stripped, trimmed content ('' for blank / comment-only lines). */
  content: string;
  /** Original text (used by block scalars). */
  raw: string;
}

type Obj = Record<string, unknown>;

const QUOTE_OPENERS = new Set([':', '-', '[', '{', ',', '?']);

function stripComment(text: string): string {
  let quote: '"' | "'" | null = null;
  let prev = ''; // previous non-space character outside quotes
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null; // '' re-opens on the next char: handled naturally
      continue;
    }
    if ((c === '"' || c === "'") && (prev === '' || QUOTE_OPENERS.has(prev))) {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || text[i - 1] === ' ')) return text.slice(0, i);
    if (c !== ' ') prev = c;
  }
  return text;
}

function toLines(src: string): Line[] {
  return src.split(/\r?\n/).map((raw, idx) => {
    const lead = /^[ \t]*/.exec(raw)?.[0] ?? '';
    if (lead.includes('\t') && raw.trim() !== '') throw new YamlError('tabs are not allowed for indentation', idx + 1);
    const body = stripComment(raw).trimEnd();
    let content = body.trim();
    if (content === '---' || content === '...') content = '';
    return { no: idx + 1, indent: lead.length, content, raw };
  });
}

const isSeqItem = (s: string): boolean => s === '-' || s.startsWith('- ');

function resolvePlain(s: string, line: number): unknown {
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?\d+$/.test(s)) return Number(s);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return Number.parseInt(s.slice(2), 16);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return Number.NaN;
  const first = s[0];
  if (first === '&' || first === '*' || first === '!') throw new YamlError(`anchors, aliases and tags are not supported ("${s}")`, line);
  if ('%@`|>'.includes(first)) throw new YamlError(`a plain value cannot start with "${first}"; quote it ("${s}")`, line);
  return s;
}

/** Parse a quoted scalar starting at s[pos]. Returns [value, index after closing quote]. */
function parseQuoted(s: string, pos: number, line: number): [string, number] {
  const q = s[pos];
  let out = '';
  for (let i = pos + 1; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return [out, i + 1];
      }
      out += c;
      continue;
    }
    if (c === '"') return [out, i + 1];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = s[++i];
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ', b: '\b', e: '\x1b' };
    if (e in simple) out += simple[e];
    else if (e === 'x' || e === 'u' || e === 'U') {
      const len = e === 'x' ? 2 : e === 'u' ? 4 : 8;
      const hex = s.slice(i + 1, i + 1 + len);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new YamlError(`bad escape \\${e}${hex}`, line);
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i += len;
    } else throw new YamlError(`unknown escape \\${e ?? ''}`, line);
  }
  throw new YamlError('unterminated quoted string', line);
}

/** `key: rest` / `key:` split for block mappings; null when the content is not a mapping entry. */
function splitKey(content: string, line: number): { key: string; rest: string } | null {
  const first = content[0];
  if (first === '{' || first === '[') return null;
  if (first === '"' || first === "'") {
    const [key, end] = parseQuoted(content, 0, line);
    const after = content.slice(end).trimStart();
    if (after === ':' || after.startsWith(': ')) return { key, rest: after.slice(1).trim() };
    return null;
  }
  // Plain key: ends at the first ':' that is followed by a space or the end of the line.
  for (let i = 0; i < content.length; i++) {
    if (content[i] === ':' && (i + 1 === content.length || content[i + 1] === ' ')) {
      const key = content.slice(0, i).trim();
      return key === '' ? null : { key, rest: content.slice(i + 1).trim() };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Flow collections
// ---------------------------------------------------------------------------

class FlowParser {
  pos = 0;
  constructor(
    private readonly s: string,
    private readonly line: number,
  ) {}

  parseAll(): unknown {
    const v = this.value();
    this.ws();
    if (this.pos < this.s.length) throw new YamlError(`unexpected "${this.s.slice(this.pos)}" after flow value`, this.line);
    return v;
  }

  private ws(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++;
  }

  private value(): unknown {
    this.ws();
    const c = this.s[this.pos];
    if (c === '{') return this.map();
    if (c === '[') return this.seq();
    if (c === '"' || c === "'") {
      const [v, end] = parseQuoted(this.s, this.pos, this.line);
      this.pos = end;
      return v;
    }
    return resolvePlain(this.plain(false), this.line);
  }

  private plain(isKey: boolean): string {
    const start = this.pos;
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c === ',' || c === ']' || c === '}') break;
      if (isKey && c === ':' && (this.pos + 1 >= this.s.length || /[\s,\]}]/.test(this.s[this.pos + 1]))) break;
      if (c === '[' || c === '{') throw new YamlError(`unexpected "${c}" inside a plain flow value`, this.line);
      this.pos++;
    }
    return this.s.slice(start, this.pos).trim();
  }

  private map(): Obj {
    this.pos++; // {
    const obj: Obj = {};
    for (;;) {
      this.ws();
      if (this.s[this.pos] === '}') {
        this.pos++;
        return obj;
      }
      let key: string;
      if (this.s[this.pos] === '"' || this.s[this.pos] === "'") {
        const [k, end] = parseQuoted(this.s, this.pos, this.line);
        key = k;
        this.pos = end;
      } else key = this.plain(true);
      this.ws();
      let value: unknown = null;
      if (this.s[this.pos] === ':') {
        this.pos++;
        this.ws();
        if (this.s[this.pos] !== ',' && this.s[this.pos] !== '}') value = this.value();
      }
      if (key in obj) throw new YamlError(`duplicate key "${key}"`, this.line);
      obj[key] = value;
      this.ws();
      const c = this.s[this.pos];
      if (c === ',') this.pos++;
      else if (c !== '}') throw new YamlError(c === undefined ? 'unterminated flow mapping' : `expected "," or "}" but found "${c}"`, this.line);
    }
  }

  private seq(): unknown[] {
    this.pos++; // [
    const arr: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.pos] === ']') {
        this.pos++;
        return arr;
      }
      arr.push(this.value());
      this.ws();
      const c = this.s[this.pos];
      if (c === ',') this.pos++;
      else if (c !== ']') throw new YamlError(c === undefined ? 'unterminated flow sequence' : `expected "," or "]" but found "${c}"`, this.line);
    }
  }
}

function flowBalanced(s: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return depth <= 0 && quote === null;
}

// ---------------------------------------------------------------------------
// Block structure
// ---------------------------------------------------------------------------

class BlockParser {
  i = 0;
  constructor(private readonly lines: Line[]) {}

  peek(): Line | undefined {
    while (this.i < this.lines.length && this.lines[this.i].content === '') this.i++;
    return this.lines[this.i];
  }

  node(indent: number): unknown {
    const l = this.peek();
    if (!l) return null;
    if (isSeqItem(l.content)) return this.seq(indent);
    if (splitKey(l.content, l.no)) return this.map(indent);
    this.i++;
    return this.inline(l.content, l);
  }

  private map(indent: number): Obj {
    const obj: Obj = {};
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < indent) return obj;
      if (l.indent > indent) throw new YamlError('unexpected indentation', l.no);
      if (isSeqItem(l.content)) throw new YamlError('a list item cannot appear here (missing key?)', l.no);
      const kv = splitKey(l.content, l.no);
      if (!kv) throw new YamlError(`expected "key: value" but found "${l.content}"`, l.no);
      if (kv.key in obj) throw new YamlError(`duplicate key "${kv.key}"`, l.no);
      this.i++;
      obj[kv.key] = this.valueAfterIndicator(kv.rest, l, indent);
    }
  }

  private seq(indent: number): unknown[] {
    const arr: unknown[] = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < indent) return arr;
      if (l.indent > indent) throw new YamlError('unexpected indentation', l.no);
      if (!isSeqItem(l.content)) return arr;
      const rest = l.content.slice(1).trimStart();
      const offset = l.content.length - rest.length;
      if (rest !== '' && (isSeqItem(rest) || splitKey(rest, l.no))) {
        // Compact nested collection: re-read this line as if `rest` started at its own column.
        const col = indent + offset;
        this.lines[this.i] = { ...l, indent: col, content: rest };
        arr.push(this.node(col));
        continue;
      }
      this.i++;
      arr.push(this.valueAfterIndicator(rest, l, indent));
    }
  }

  /** Value after `key:` or `-`: inline scalar/flow, block scalar, or a nested block. */
  private valueAfterIndicator(rest: string, l: Line, indent: number): unknown {
    if (rest === '') {
      const n = this.peek();
      if (n && n.indent > indent) return this.node(n.indent);
      if (n && n.indent === indent && isSeqItem(n.content) && !isSeqItem(l.content)) return this.seq(indent);
      return null;
    }
    if (/^[|>][-+]?$/.test(rest)) return this.blockScalar(rest, indent);
    if (isSeqItem(rest)) throw new YamlError('a list item cannot start on the same line as its key', l.no);
    return this.inline(rest, l);
  }

  private inline(text: string, l: Line): unknown {
    if (text[0] === '{' || text[0] === '[') {
      let s = text;
      while (!flowBalanced(s)) {
        const n = this.lines[this.i];
        if (!n) throw new YamlError('unterminated flow collection', l.no);
        this.i++;
        if (n.content !== '') s += ` ${n.content}`;
      }
      return new FlowParser(s, l.no).parseAll();
    }
    if (text[0] === '"' || text[0] === "'") {
      const [v, end] = parseQuoted(text, 0, l.no);
      if (text.slice(end).trim() !== '') throw new YamlError(`unexpected "${text.slice(end).trim()}" after quoted value`, l.no);
      return v;
    }
    return resolvePlain(text, l.no);
  }

  private blockScalar(header: string, parentIndent: number): string {
    const folded = header[0] === '>';
    const chomp = header[1] ?? '';
    const body: string[] = [];
    let contentIndent = -1;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      const blank = l.raw.trim() === '';
      if (!blank && l.indent <= parentIndent) break;
      if (!blank && contentIndent < 0) contentIndent = l.indent;
      body.push(blank ? '' : l.raw.slice(Math.max(0, contentIndent)));
      this.i++;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing++;
    }
    let text: string;
    if (folded) {
      text = '';
      body.forEach((ln, idx) => {
        if (idx === 0) text = ln;
        else if (ln === '') text += '\n';
        else text += text.endsWith('\n') || text === '' ? ln : ` ${ln}`;
      });
    } else text = body.join('\n');
    if (chomp === '-') return text;
    if (chomp === '+') return `${text}\n${'\n'.repeat(trailing)}`;
    return body.length ? `${text}\n` : '';
  }
}

/** Parse a YAML document (subset, see file header). */
export function parseYaml(src: string): unknown {
  const p = new BlockParser(toLines(src));
  const first = p.peek();
  if (!first) return null;
  const v = p.node(first.indent);
  const rest = p.peek();
  if (rest) throw new YamlError(`unexpected content "${rest.content}"`, rest.no);
  return v;
}
