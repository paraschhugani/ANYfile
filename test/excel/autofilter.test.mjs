// Spreadsheet filters on a header row (src/react/view/excel/x-spreadsheet/core/auto_filter.js):
// like Excel / Google Sheets, a filter on just the header row covers the data below it.
// Run: node --test test/excel/autofilter.test.mjs
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const { default: AutoFilter, autofilterRangeFor, CellRange } = await (async () => {
    const result = await build({
        stdin: {
            contents: `export { default, autofilterRangeFor } from './core/auto_filter.js'; export { CellRange } from './core/cell_range.js';`,
            resolveDir: join(ROOT, 'src/react/view/excel/x-spreadsheet'),
        },
        bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
    });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
})();

// A sheet like the report in the bug: a header row, data, then an empty row and an unrelated block.
const SHEET = [
    ['Element', 'Axis', 'Code'],
    ['S1', 'option', '1'],
    ['S1', '', '2'],
    ['S2', 'option', ''],
    [],
    ['Notes', 'x', 'y'],
];
const getCell = (ri, ci) => {
    const text = SHEET[ri]?.[ci];
    return text === undefined ? null : { text };
};

function filterWithRef(ref) {
    const filter = new AutoFilter();
    filter.setData({ ref });
    return filter;
}

test('a filter saved on just the header row lists the values below it (stops at the first empty row)', () => {
    const filter = filterWithRef('A1:C1');
    assert.deepEqual(filter.items(0, getCell), { S1: 2, S2: 1 });
    assert.deepEqual(filter.items(1, getCell), { option: 2, '': 1 });
    assert.deepEqual([...filter.filteredRows(getCell).fset], [1, 2, 3]);
});

test('a filter with data rows in its range behaves as before', () => {
    const filter = filterWithRef('A1:C3');
    assert.deepEqual(filter.items(0, getCell), { S1: 2 });
    assert.equal(filter.range().toString(), 'A1:C3');
});

test('filtering a header-only range hides the right rows', () => {
    const filter = filterWithRef('A1:C1');
    filter.addFilter(0, 'in', ['S2']);
    const { rset, fset } = filter.filteredRows(getCell);
    assert.deepEqual([...fset], [3]);
    assert.deepEqual([...rset], [1, 2]);
});

test('creating a filter from one header cell covers the whole header and its data', () => {
    assert.equal(autofilterRangeFor(new CellRange(0, 1, 0, 1), getCell).toString(), 'A1:C4');
});

test('creating a filter from the whole first row uses only its filled columns', () => {
    assert.equal(autofilterRangeFor(new CellRange(0, 0, 0, 25), getCell).toString(), 'A1:C4');
});

test('creating a filter from a selection with several rows keeps the selection', () => {
    assert.equal(autofilterRangeFor(new CellRange(0, 0, 1, 2), getCell).toString(), 'A1:C2');
});

test('a header with no data below stays a header-only filter (and lists nothing)', () => {
    const range = autofilterRangeFor(new CellRange(5, 0, 5, 2), getCell);
    assert.equal(range.toString(), 'A6:C6');
    assert.deepEqual(filterWithRef('A6:C6').items(0, getCell), {});
});
