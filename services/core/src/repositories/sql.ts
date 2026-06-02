/**
 * Small, dependency-free SQL fragment builders used by the repository layer.
 *
 * These helpers produce **parameterized** SQL (placeholders `$1, $2, …`) so the
 * repositories are injection-safe and driver-agnostic over the narrow
 * {@link SqlClient} port. They have no notion of a specific table; they only
 * assemble predicate lists, SET clauses, and INSERT column/value lists while
 * keeping the positional parameter array in lock-step with the placeholders.
 *
 * Tenant-predicate injection itself lives in the base repository
 * (`base-repository.ts`); this module is the mechanical layer it builds on.
 */

/** A single equality (`=`) or set-membership (`IN`) predicate on a column. */
export interface Predicate {
  /** The column being constrained (a trusted identifier, never user input). */
  column: string;
  /** Comparison operator. Defaults to `=`. `in` constrains against an array value. */
  op?: '=' | 'in';
  /** The value (or array of values for `in`) to bind as a positional parameter. */
  value: unknown;
}

/**
 * Accumulates positional parameters and hands out the matching `$n`
 * placeholders, keeping the SQL text and the parameter array consistent.
 */
export class ParamCollector {
  private readonly values: unknown[] = [];

  /** Bind a value and return its `$n` placeholder. */
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  /** The collected positional parameters, in placeholder order. */
  get params(): unknown[] {
    return this.values;
  }
}

/**
 * Render a list of predicates into a `WHERE` body (without the `WHERE`
 * keyword), binding each value through `params`. Predicates are AND-ed in the
 * order given, so callers that must guarantee a leading predicate (the tenant
 * scope) simply place it first.
 *
 * @returns The SQL condition string, e.g. `organization_id = $1 AND id = $2`.
 */
export function renderPredicates(predicates: Predicate[], params: ParamCollector): string {
  return predicates
    .map((predicate) => {
      const op = predicate.op ?? '=';
      if (op === 'in') {
        const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
        if (values.length === 0) {
          // An empty IN list matches nothing; keep it well-formed and false.
          return 'FALSE';
        }
        const placeholders = values.map((value) => params.add(value));
        return `${predicate.column} IN (${placeholders.join(', ')})`;
      }
      return `${predicate.column} = ${params.add(predicate.value)}`;
    })
    .join(' AND ');
}

/** A column/value pair bound for an INSERT or UPDATE. */
export interface ColumnValue {
  /** The target column (a trusted identifier). */
  column: string;
  /** The value to bind as a positional parameter. */
  value: unknown;
}

/**
 * Render the `(columns) VALUES ($1, …)` portion of an INSERT, binding each
 * value through `params`.
 */
export function renderInsertColumns(
  columnValues: ColumnValue[],
  params: ParamCollector,
): { columns: string; placeholders: string } {
  const columns = columnValues.map((cv) => cv.column).join(', ');
  const placeholders = columnValues.map((cv) => params.add(cv.value)).join(', ');
  return { columns, placeholders };
}

/**
 * Render the `col = $n, …` body of an UPDATE `SET` clause, binding each value
 * through `params`.
 */
export function renderSetClause(columnValues: ColumnValue[], params: ParamCollector): string {
  return columnValues.map((cv) => `${cv.column} = ${params.add(cv.value)}`).join(', ');
}
