import { CellRange } from './cell_range';

function isBlank(cell) {
  return cell == null || cell.text == null || /^\s*$/.test(String(cell.text));
}

function rowHasData(getCell, ri, sci, eci) {
  for (let ci = sci; ci <= eci; ci += 1) {
    if (!isBlank(getCell(ri, ci))) return true;
  }
  return false;
}

/**
 * Like Excel and Google Sheets: a filter set on just a header row covers the block of data below it,
 * down to the first empty row. Ranges with data rows are returned unchanged.
 */
export function extendHeaderRange(range, getCell) {
  if (range.eri > range.sri) return range;
  let eri = range.sri;
  while (rowHasData(getCell, eri + 1, range.sci, range.eci)) {
    eri += 1;
  }
  return new CellRange(range.sri, range.sci, eri, range.eci);
}

/**
 * The range for a new filter on `selection`. A multi-row selection is used as is. A single row (or
 * one cell) is taken as the header: one cell grows to the neighbouring header cells, a whole row
 * shrinks to its used cells, then the range extends down over the data.
 */
export function autofilterRangeFor(selection, getCell) {
  if (selection.eri > selection.sri) return selection;
  const ri = selection.sri;
  let { sci, eci } = selection;
  if (sci === eci) {
    while (sci > 0 && !isBlank(getCell(ri, sci - 1))) sci -= 1;
    while (!isBlank(getCell(ri, eci + 1))) eci += 1;
  } else {
    let first = sci;
    let last = eci;
    while (first <= last && isBlank(getCell(ri, first))) first += 1;
    while (last >= first && isBlank(getCell(ri, last))) last -= 1;
    if (first <= last) {
      sci = first;
      eci = last;
    }
  }
  return extendHeaderRange(new CellRange(ri, sci, ri, eci), getCell);
}
// operator: all|eq|neq|gt|gte|lt|lte|in|be
// value:
//   in => []
//   be => [min, max]
class Filter {
  constructor(ci, operator, value) {
    this.ci = ci;
    this.operator = operator;
    this.value = value;
  }

  set(operator, value) {
    this.operator = operator;
    this.value = value;
  }

  includes(v) {
    const { operator, value } = this;
    if (operator === 'all') {
      return true;
    }
    if (operator === 'in') {
      return value.includes(v);
    }
    return false;
  }

  vlength() {
    const { operator, value } = this;
    if (operator === 'in') {
      return value.length;
    }
    return 0;
  }

  getData() {
    const { ci, operator, value } = this;
    return { ci, operator, value };
  }
}

class Sort {
  constructor(ci, order) {
    this.ci = ci;
    this.order = order;
  }

  asc() {
    return this.order === 'asc';
  }

  desc() {
    return this.order === 'desc';
  }
}

export default class AutoFilter {
  constructor() {
    this.ref = null;
    this.filters = [];
    this.sort = null;
  }

  setData(data) {
    if (!data || data.ref == null) {
      this.clear();
      return;
    }
    this.ref = data.ref;
    this.filters = (data.filters || []).map(it => new Filter(it.ci, it.operator, it.value));
    this.sort = data.sort ? new Sort(data.sort.ci, data.sort.order) : null;
  }

  getData() {
    if (this.active()) {
      const { ref, filters, sort } = this;
      return { ref, filters: filters.map(it => it.getData()), sort };
    }
    return {};
  }

  addFilter(ci, operator, value) {
    const filter = this.getFilter(ci);
    if (filter == null) {
      this.filters.push(new Filter(ci, operator, value));
    } else {
      filter.set(operator, value);
    }
  }

  setSort(ci, order) {
    this.sort = order ? new Sort(ci, order) : null;
  }

  includes(ri, ci) {
    if (this.active()) {
      return this.hrange().includes(ri, ci);
    }
    return false;
  }

  getSort(ci) {
    const { sort } = this;
    if (sort && sort.ci === ci) {
      return sort;
    }
    return null;
  }

  getFilter(ci) {
    const { filters } = this;
    for (let i = 0; i < filters.length; i += 1) {
      if (filters[i].ci === ci) {
        return filters[i];
      }
    }
    return null;
  }

  filteredRows(getCell) {
    const rset = new Set();
    const fset = new Set();
    if (this.active()) {
      const { sri, eri } = this.dataRange(getCell);
      const { filters } = this;
      // 首行 sri 为表头，不参与筛选
      for (let ri = sri + 1; ri <= eri; ri += 1) {
        let visible = filters.length === 0;
        for (let i = 0; i < filters.length; i += 1) {
          const filter = filters[i];
          const cell = getCell(ri, filter.ci);
          const ctext = cell ? cell.text : '';
          if (filter.includes(ctext)) {
            visible = true;
          } else {
            visible = false;
            break;
          }
        }
        if (visible) {
          fset.add(ri);
        } else {
          rset.add(ri);
        }
      }
    }
    return { rset, fset };
  }

  items(ci, getCell) {
    const m = {};
    if (this.active()) {
      const { sri, eri } = this.dataRange(getCell);
      for (let ri = sri + 1; ri <= eri; ri += 1) {
        const cell = getCell(ri, ci);
        if (cell !== null && !/^\s*$/.test(cell.text)) {
          const key = cell.text;
          const cnt = (m[key] || 0) + 1;
          m[key] = cnt;
        } else {
          m[''] = (m[''] || 0) + 1;
        }
      }
    }
    return m;
  }

  range() {
    return CellRange.valueOf(this.ref);
  }

  /** The rows the filter applies to: a saved range that is only the header row covers the data below it. */
  dataRange(getCell) {
    return extendHeaderRange(this.range(), getCell);
  }

  hrange() {
    const r = this.range();
    r.eri = r.sri;
    return r;
  }

  clear() {
    this.ref = null;
    this.filters = [];
    this.sort = null;
  }

  active() {
    return this.ref !== null;
  }
}
