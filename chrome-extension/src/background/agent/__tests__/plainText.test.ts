import { describe, it, expect } from 'vitest';
import { toPlainText } from '../plainText';

describe('toPlainText', () => {
  it('removes bold, headings and bullets but keeps the line structure', () => {
    const input = [
      '## Prioritas tinggi',
      '**Hero section**',
      '- Perjelas headline dan subheadline',
      '* Gunakan satu CTA utama',
      '',
      '### Kategori produk',
      '• Tambahkan kategori seperti dekorasi',
    ].join('\n');
    expect(toPlainText(input)).toBe(
      [
        'Prioritas tinggi',
        'Hero section',
        'Perjelas headline dan subheadline',
        'Gunakan satu CTA utama',
        '',
        'Kategori produk',
        'Tambahkan kategori seperti dekorasi',
      ].join('\n'),
    );
  });

  it('turns a bold label into an ordinary label', () => {
    expect(toPlainText('**Harga:** Rp 150.000')).toBe('Harga: Rp 150.000');
  });

  it('keeps numbered steps, which are writing rather than markup', () => {
    expect(toPlainText('1. Buka halaman\n2) Klik **Simpan**')).toBe('1. Buka halaman\n2) Klik Simpan');
  });

  it('drops backticks, fences, quotes and horizontal rules', () => {
    expect(toPlainText('Ketik `npm install`\n---\n> kutipan\n```\ncode()\n```')).toBe(
      'Ketik npm install\nkutipan\ncode()',
    );
  });

  it('makes links readable without brackets', () => {
    expect(toPlainText('Lihat [dokumentasi](https://x.test/docs) dan [https://y.test](https://y.test)')).toBe(
      'Lihat dokumentasi (https://x.test/docs) dan https://y.test',
    );
  });

  it('removes a half-open bold marker', () => {
    expect(toPlainText('Total **Rp 20.000')).toBe('Total Rp 20.000');
  });

  it('leaves stars and underscores inside words alone', () => {
    expect(toPlainText('2*3*4 = 24, a * b, snake_case_name, __init__')).toBe(
      '2*3*4 = 24, a * b, snake_case_name, __init__',
    );
  });

  it('strips single-star emphasis at word edges', () => {
    expect(toPlainText('ini *penting* dan (*juga*).')).toBe('ini penting dan (juga).');
  });

  it('keeps pipe tables, which the panel renders as a real table', () => {
    const table = '| Toko | Harga |\n| --- | --- |\n| A | **Rp 10** |';
    expect(toPlainText(table)).toBe('| Toko | Harga |\n| --- | --- |\n| A | Rp 10 |');
  });

  it('rewrites em and en dashes', () => {
    expect(toPlainText('Flowkite — agen browser. Halaman 10–20.\n— item')).toBe(
      'Flowkite, agen browser. Halaman 10-20.\nitem',
    );
  });

  it('collapses the blank lines left behind by removed markup', () => {
    expect(toPlainText('a\n\n---\n\nb')).toBe('a\n\nb');
  });

  it('passes plain prose through untouched', () => {
    const prose = 'Urutan terbaik berikutnya: hero section → kategori produk → testimoni.';
    expect(toPlainText(prose)).toBe(prose);
  });
});
