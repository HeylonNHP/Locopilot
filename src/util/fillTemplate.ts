/**
 * Template filling for prompt text.
 *
 * Chained `template.replace('{name}', value)` has three defects: a string
 * pattern replaces only the FIRST occurrence, a string replacement is parsed
 * for the special sequences `$&`, `` $` ``, `$'` and `$$`, and a value that
 * contains a later placeholder is substituted again. `fillTemplate` does one
 * pass with a replacer function, which has none of them.
 */

const PLACEHOLDER_PATTERN = /{([A-Za-z]\w*)}/g;

/** The values to insert, by placeholder name. */
export type TemplateValues = Readonly<Record<string, string | number>>;

/**
 * Fills every `{name}` placeholder in `template` in ONE regex pass.
 *
 * - Every occurrence is filled, not only the first.
 * - A value is inserted literally: `$&`, `$$` and friends are not interpreted.
 * - Inserted text is never scanned again, so a value that contains `{other}`
 *   stays as written.
 * - Only identifier-shaped placeholders match, so JSON-like braces (`{}`,
 *   `{"k":1}`, `{1}`) in a template are left alone.
 *
 * @throws Error when the template names a placeholder `values` lacks. Templates
 *   are constants, so that is a programming error and the unit tests catch it.
 */
export function fillTemplate(template: string, values: TemplateValues): string {
  return template.replaceAll(PLACEHOLDER_PATTERN, (placeholder: string, name: string) => {
    // Own keys only: `{constructor}` must not resolve to Object.prototype.
    if (!Object.hasOwn(values, name)) {
      throw new Error(`Template placeholder ${placeholder} has no value`);
    }
    return String(values[name]);
  });
}
