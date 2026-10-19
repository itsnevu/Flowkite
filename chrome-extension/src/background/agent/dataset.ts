/**
 * The rows one task collects, held for as long as that task runs.
 *
 * `extract_content` answers a question and the answer rides back through the model's context. That
 * is the right shape for "what is the price of this" and the wrong shape for "every product on all
 * nine pages": the rows would be re-read, re-summarised and re-emitted on every step until the
 * context ceiling cut them off. So repeated records go here instead — accumulated outside the
 * conversation, deduplicated as they arrive, and handed to the panel once at the end. The model
 * only ever sees a count and a two-row sample, which is all it needs to decide whether to page on.
 *
 * Kept free of imports so the accumulation rules can be asserted without standing up a model, a
 * browser context or an event manager first.
 */

/** One extracted record, keyed by field name. */
export type DatasetRecord = Record<string, string>;

/**
 * Columns the dataset will carry. Past a dozen the extractor starts inventing fields to fill, and
 * a table that wide is unreadable in a side panel anyway.
 */
export const MAX_DATASET_FIELDS = 12;

/**
 * Rows kept before further ones are dropped. Generous enough for a real scrape, bounded so a
 * runaway pagination loop cannot fill the session store.
 */
export const MAX_DATASET_ROWS = 2000;

/** Cap per cell, so one page of boilerplate cannot crowd out the column it landed in. */
export const MAX_CELL_CHARS = 500;

/** What one `add` call did, in the terms the action reports back to the model. */
export interface DatasetAddResult {
  added: number;
  /** records already held, skipped rather than stored twice */
  duplicates: number;
  /** records dropped because the dataset is full, or their columns did not fit */
  dropped: number;
  total: number;
}

/** The dataset as it leaves the background worker. */
export interface DatasetSnapshot {
  fields: string[];
  rows: string[][];
  /** true once something was dropped, so the panel can say the table is not the whole story */
  truncated: boolean;
}

/**
 * Cells arrive from page text, so they arrive however the page felt like writing them. Newlines in
 * particular have to go: a cell holding one would survive CSV quoting but break every table that
 * renders it, and nothing tabular needs them.
 */
const normalizeCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_CELL_CHARS ? `${collapsed.slice(0, MAX_CELL_CHARS)}…` : collapsed;
};

/** Field names are column headers, so they get the same treatment plus a length a header can wear. */
const normalizeField = (name: string): string => normalizeCell(name).slice(0, 60);

export class TaskDataset {
  /** Column order, first-seen. A later extraction with new fields appends; it never reorders. */
  private fields: string[] = [];
  private rows: string[][] = [];
  /** Identity of every row held, so re-extracting a page the agent already read adds nothing. */
  private readonly seen = new Set<string>();
  private truncatedFlag = false;

  /**
   * A record's identity, independent of column order and of columns added later.
   *
   * Sorting the entries is what makes that true: the same record extracted before and after a new
   * column appeared produces the same key, so paging back over a page already read is free rather
   * than duplicating everything on it.
   */
  private static identity(record: DatasetRecord): string {
    return JSON.stringify(
      Object.entries(record)
        .map(([field, value]) => [normalizeField(field), normalizeCell(value)])
        .filter(([, value]) => value !== '')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }

  /**
   * Take a batch of records, keeping the ones that are new and say what happened to the rest.
   *
   * Records with nothing in them are dropped rather than stored: an extractor that finds no matches
   * on a page routinely answers with a row of empty strings, and a table of blanks is worse than a
   * table that is honestly shorter.
   */
  add(records: DatasetRecord[]): DatasetAddResult {
    const result: DatasetAddResult = { added: 0, duplicates: 0, dropped: 0, total: this.rows.length };

    for (const record of records) {
      if (!record || typeof record !== 'object') {
        result.dropped += 1;
        continue;
      }

      const identity = TaskDataset.identity(record);
      // "[]" is what an all-empty record normalises to: nothing worth a row.
      if (identity === '[]') {
        result.dropped += 1;
        continue;
      }
      if (this.seen.has(identity)) {
        result.duplicates += 1;
        continue;
      }
      if (this.rows.length >= MAX_DATASET_ROWS) {
        result.dropped += 1;
        this.truncatedFlag = true;
        continue;
      }

      this.absorbFields(record);
      this.seen.add(identity);
      // `hasOwnProperty`, not `??`. Records come from `JSON.parse`, so they carry Object.prototype,
      // and `??` only falls through on null/undefined - a column the extractor named `constructor`
      // or `toString` would return the prototype's member for every later record that lacks it, and
      // the user's CSV would show `function toString() { [native code] }` as a value.
      this.rows.push(
        this.fields.map(field =>
          normalizeCell(
            Object.prototype.hasOwnProperty.call(record, field) ? record[field] : this.lookupLoosely(record, field),
          ),
        ),
      );
      result.added += 1;
    }

    result.total = this.rows.length;
    return result;
  }

  /**
   * Widen the table to cover a record's fields, padding the rows already stored.
   *
   * Once the column cap is reached the extra fields are ignored rather than rejected: the record
   * still carries the columns that matter, and dropping it whole over a stray thirteenth field
   * would lose real data to a formatting accident.
   */
  private absorbFields(record: DatasetRecord): void {
    for (const rawField of Object.keys(record)) {
      const field = normalizeField(rawField);
      if (field === '' || this.fields.includes(field)) continue;
      if (this.fields.length >= MAX_DATASET_FIELDS) {
        this.truncatedFlag = true;
        continue;
      }
      this.fields.push(field);
      for (const row of this.rows) row.push('');
    }
  }

  /** The value a record holds for a column whose name was normalised on the way in. */
  private lookupLoosely(record: DatasetRecord, field: string): string {
    for (const [key, value] of Object.entries(record)) {
      if (normalizeField(key) === field) return value;
    }
    return '';
  }

  get rowCount(): number {
    return this.rows.length;
  }

  get columns(): string[] {
    return [...this.fields];
  }

  isEmpty(): boolean {
    return this.rows.length === 0;
  }

  snapshot(): DatasetSnapshot {
    return { fields: [...this.fields], rows: this.rows.map(row => [...row]), truncated: this.truncatedFlag };
  }

  /** Rebuild a saved crawl table through the same normalization and deduplication path. */
  restore(snapshot: DatasetSnapshot): void {
    this.clear();
    this.add(
      snapshot.rows.map(row => Object.fromEntries(snapshot.fields.map((field, index) => [field, row[index] ?? '']))),
    );
    this.truncatedFlag ||= snapshot.truncated;
  }

  /** Forget everything. A follow-up task starts its own collection, not a continuation. */
  clear(): void {
    this.fields = [];
    this.rows = [];
    this.seen.clear();
    this.truncatedFlag = false;
  }

  /**
   * The last few rows, as a compact `field: value` listing for the model.
   *
   * A sample, deliberately, not the data: the whole point of the dataset is that the rows do not
   * ride through the context. Enough for the model to notice it is collecting blanks, and no more.
   */
  preview(limit = 2): string {
    if (this.rows.length === 0) return '';
    return this.rows
      .slice(-limit)
      .map(row =>
        this.fields
          .map((field, index) => `${field}: ${row[index] ?? ''}`)
          .filter(pair => !pair.endsWith(': '))
          .join(' | '),
      )
      .join('\n');
  }
}

/**
 * The records inside whatever the extractor model actually said.
 *
 * Structured output is asked for, not guaranteed: the same prompt gets a bare array from one
 * provider, a fenced code block from the next, and a `{"records": [...]}` wrapper from the one
 * after that. All three carry the same rows, so all three are read rather than one being declared
 * correct and the other two lost. Anything with no array in it at all returns an empty list, which
 * the caller reports as "found nothing here" — the honest reading of a page with no matches.
 */
export function parseRecords(raw: string): DatasetRecord[] {
  const text = raw.trim();
  if (text === '') return [];

  const direct = readJson(stripFence(text));
  const value = direct ?? readJson(sliceOutermost(text, '[', ']')) ?? readJson(sliceOutermost(text, '{', '}'));
  if (value === null) return [];

  if (Array.isArray(value)) return value.filter(isRecordish) as DatasetRecord[];

  if (typeof value === 'object') {
    // A single record, or an object wrapping the array under some key the model chose.
    //
    // The wrapper has to actually look like one: matching any array at all meant a lone record with
    // an array-valued field (`{"name":"Kite","tags":["red"]}`) was read as a wrapper around `tags`,
    // filtered to nothing, and reported to the model as "no records on this page" - so the model
    // paginated past a page that did have data. An empty array was worse, being truthy.
    const wrapped = Object.values(value as Record<string, unknown>).find(
      candidate => Array.isArray(candidate) && candidate.length > 0 && candidate.every(isRecordish),
    );
    if (wrapped) return wrapped as DatasetRecord[];
    if (isRecordish(value)) return [value as DatasetRecord];
  }

  return [];
}

const isRecordish = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;

/** Drop a ```json … ``` wrapper if the whole answer is one. */
const stripFence = (text: string): string => {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  return fenced ? fenced[1].trim() : text;
};

/** The span from the first `open` to the last `close`, for an answer with prose around the JSON. */
const sliceOutermost = (text: string, open: string, close: string): string => {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start === -1 || end <= start ? '' : text.slice(start, end + 1);
};

const readJson = (text: string): unknown => {
  if (text === '') return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
};
