const MAX_FORMS = 20;
const MAX_FIELDS_PER_FORM = 50;
const MAX_TABLES = 10;
const MAX_ROWS_PER_TABLE = 50;
const MAX_ROWS_PER_TABLE_READ = 200;
const MAX_CELLS_PER_ROW = 20;
const MAX_OPTIONS_PER_SELECT = 50;
const MAX_TEXT_LENGTH = 300;
const SENSITIVE_FIELD_PATTERN = /(pass(?:word)?|secret|token|api[_-]?key|auth|credential|card|cvv)/i;

/**
 * Return a small, serializable supplement to an accessibility snapshot.
 * This intentionally exposes page structure rather than arbitrary HTML.
 */
export async function extractPageStructure(page) {
  if (!page || page.isClosed()) return null;

  try {
    return await page.evaluate((limits) => {
      const sensitiveFieldPattern = new RegExp(limits.sensitiveFieldPattern, 'i');
      const text = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limits.maxTextLength);
      const labelFor = (element) => {
        const aria = element.getAttribute('aria-label');
        if (aria) return text(aria);
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
          const labels = labelledBy.split(/\s+/)
            .map((id) => document.getElementById(id))
            .filter(Boolean)
            .map((label) => text(label.textContent))
            .filter(Boolean);
          if (labels.length) return labels.join(' ');
        }
        if (element.id) {
          const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
          if (label) return text(label.textContent);
        }
        const wrappingLabel = element.closest('label');
        if (wrappingLabel) return text(wrappingLabel.textContent);
        return text(element.getAttribute('title') || element.getAttribute('name') || element.id);
      };
      const sensitive = (element) => element.type === 'password'
        || sensitiveFieldPattern.test(`${element.id || ''} ${element.name || ''} ${element.autocomplete || ''}`);
      const fieldFor = (element) => {
        const tag = element.tagName.toLowerCase();
        const type = (element.getAttribute('type') || (tag === 'select' ? 'select' : '')).toLowerCase();
        const result = {
          label: labelFor(element),
          role: tag === 'select' ? 'combobox' : (type === 'checkbox' ? 'checkbox' : (type === 'radio' ? 'radio' : 'textbox')),
          tag,
          type,
          id: element.id || undefined,
          name: element.getAttribute('name') || undefined,
          disabled: Boolean(element.disabled),
        };
        if (!sensitive(element) && tag !== 'button' && type !== 'file') {
          result.value = text(element.value);
        }
        if (tag === 'select') {
          const options = Array.from(element.options).slice(0, limits.maxOptions)
            .map((option) => ({ label: text(option.textContent), value: option.value, selected: option.selected }));
          result.options = options;
          result.optionsTruncated = element.options.length > options.length;
        }
        return result;
      };
      const forms = Array.from(document.forms).slice(0, limits.maxForms).map((form) => {
        const elements = Array.from(form.querySelectorAll('input, select, textarea'))
          .filter((element) => !['hidden', 'submit', 'reset', 'button', 'image'].includes((element.type || '').toLowerCase()));
        const fields = elements.slice(0, limits.maxFields).map(fieldFor);
        const submitControls = Array.from(form.querySelectorAll('button, input[type="submit"], input[type="image"]'))
          .slice(0, limits.maxFields)
          .map((element) => ({ label: labelFor(element) || text(element.value), id: element.id || undefined, name: element.getAttribute('name') || undefined, disabled: Boolean(element.disabled) }));
        return {
          label: labelFor(form) || undefined,
          id: form.id || undefined,
          name: form.getAttribute('name') || undefined,
          method: (form.getAttribute('method') || 'get').toLowerCase(),
          fields,
          fieldsTruncated: elements.length > fields.length,
          submitControls,
        };
      });
      const tables = Array.from(document.querySelectorAll('table')).slice(0, limits.maxTables).map((table, tableIndex) => {
        const headers = Array.from(table.querySelectorAll('thead th')).map((cell) => text(cell.textContent));
        const rows = Array.from(table.querySelectorAll('tbody tr'));
        const visibleRows = rows.slice(0, limits.maxRows).map((row) => Array.from(row.querySelectorAll('th, td'))
          .slice(0, limits.maxCells).map((cell) => text(cell.textContent)));
        return {
          // Stable per-snapshot id so /tables/:tableId/rows can address this
          // table even when the DOM provides no id attribute.
          tableId: table.id || `table-${tableIndex + 1}`,
          label: labelFor(table) || table.getAttribute('aria-label') || undefined,
          id: table.id || undefined,
          headers,
          columns: headers,
          rowCount: rows.length,
          rows: visibleRows,
          rowsTruncated: rows.length > visibleRows.length,
        };
      });
      const evidenceLimits = tables.map((table) => ({
        source: 'table',
        tableId: table.tableId,
        tableLabel: table.label,
        availableDimensions: table.headers,
        visibleRowCount: table.rowCount,
        rowsTruncated: table.rowsTruncated,
      }));
      return {
        forms,
        formsTruncated: document.forms.length > forms.length,
        tables,
        tablesTruncated: document.querySelectorAll('table').length > tables.length,
        evidenceLimits,
      };
    }, {
      maxForms: MAX_FORMS,
      maxFields: MAX_FIELDS_PER_FORM,
      maxTables: MAX_TABLES,
      maxRows: MAX_ROWS_PER_TABLE,
      maxCells: MAX_CELLS_PER_ROW,
      maxOptions: MAX_OPTIONS_PER_SELECT,
      maxTextLength: MAX_TEXT_LENGTH,
      sensitiveFieldPattern: SENSITIVE_FIELD_PATTERN.source,
    });
  } catch {
    // Snapshot availability must not depend on optional DOM structure extraction.
    return null;
  }
}

/**
 * Read a row-paginated, read-only view of a single advertised table. The
 * tableId must come from a snapshot's structure (table.id or the positional
 * `table-N` fallback). Rowspan/colspan are expanded so every returned row
 * aligns cell-for-cell with the header fields. Tables containing credential,
 * secret, token, or api-key inputs are not treated as a data source.
 */
export async function extractTableRows(page, tableId, offset = 0) {
  if (!page || page.isClosed() || typeof tableId !== 'string' || !tableId) return null;

  try {
    return await page.evaluate(({ tableId: requestedTableId, requestedOffset, limits }) => {
      const text = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limits.maxTextLength);
      const tables = Array.from(document.querySelectorAll('table')).slice(0, limits.maxTables);
      const tableIndex = tables.findIndex((table, index) => (table.id || `table-${index + 1}`) === requestedTableId);
      if (tableIndex < 0) return null;

      const table = tables[tableIndex];
      // A table that contains sensitive controls is not a data source for this endpoint.
      if (table.querySelector('input[type="password"], input[name*="password" i], input[name*="secret" i], input[name*="token" i], input[name*="api_key" i]')) return null;

      // Expand rowspan/colspan so every returned row aligns cell-for-cell with the header fields.
      const gridRows = (tableEl, limitRows) => {
        const carry = new Map();
        const grid = [];
        const domRows = Array.from(tableEl.querySelectorAll('tbody tr'));
        for (const row of domRows.slice(0, limitRows)) {
          const cells = [];
          let column = 0;
          const cellList = Array.from(row.querySelectorAll('th, td'));
          let cellIndex = 0;
          while (cellIndex < cellList.length || carry.has(column)) {
            if (carry.has(column)) {
              const span = carry.get(column);
              cells.push(span.value);
              if (--span.remaining <= 0) carry.delete(column);
              column += 1;
              continue;
            }
            const cell = cellList[cellIndex++];
            const value = text(cell.textContent);
            const colSpan = Math.max(1, Number(cell.getAttribute('colspan')) || 1);
            const rowSpan = Math.max(1, Number(cell.getAttribute('rowspan')) || 1);
            for (let cellOffset = 0; cellOffset < colSpan; cellOffset += 1) {
              const cellValue = cellOffset === 0 ? value : '';
              cells.push(cellValue);
              if (rowSpan > 1) carry.set(column + cellOffset, { value: cellValue, remaining: rowSpan - 1 });
            }
            column += colSpan;
          }
          grid.push(cells.slice(0, limits.maxCells));
        }
        return { grid, totalRows: domRows.length };
      };
      const requestedStart = Number.isInteger(requestedOffset) ? requestedOffset : 0;
      const { grid, totalRows } = gridRows(table, Math.max(0, requestedStart) + limits.maxRows);
      const rows = { length: totalRows };
      const start = Math.max(0, Math.min(requestedStart, rows.length));
      const returnedRows = grid.slice(start, start + limits.maxRows);
      const nextOffset = start + returnedRows.length;
      const label = text(table.getAttribute('aria-label') || table.getAttribute('title') || table.getAttribute('name') || table.id) || undefined;
      const fields = Array.from(table.querySelectorAll('thead th')).map((cell) => text(cell.textContent));
      return {
        tableId: table.id || `table-${tableIndex + 1}`,
        label,
        fields,
        totalRows: rows.length,
        offset: start,
        rows: returnedRows,
        pagination: {
          available: nextOffset < rows.length,
          unit: 'row',
          nextOffset: nextOffset < rows.length ? nextOffset : null,
        },
      };
    }, {
      tableId,
      requestedOffset: Number(offset),
      limits: {
        maxTables: MAX_TABLES,
        maxRows: MAX_ROWS_PER_TABLE_READ,
        maxCells: MAX_CELLS_PER_ROW,
        maxTextLength: MAX_TEXT_LENGTH,
      },
    });
  } catch {
    return null;
  }
}

/** Add existing accessibility refs where a DOM control has an unambiguous match. */
export function attachStructureRefs(structure, refs) {
  if (!structure || !(refs instanceof Map)) return structure;
  const refByRoleAndName = new Map();
  for (const [ref, info] of refs) {
    refByRoleAndName.set(`${info.role}:${info.name}:${info.nth}`, ref);
  }
  const assign = (control, role) => {
    if (!control?.label) return;
    const ref = refByRoleAndName.get(`${role}:${control.label}:0`);
    if (ref) control.ref = ref;
  };
  for (const form of structure.forms || []) {
    for (const field of form.fields || []) assign(field, field.role);
    for (const control of form.submitControls || []) assign(control, 'button');
  }
  return structure;
}
