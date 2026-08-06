/**
 * Strips terminal control sequences before command output is sent to the model.
 * Kept in a leaf module so command execution does not depend on the tool registry.
 */
export function sanitize(text: string): string {
  return (
    text
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '')
      .replaceAll(
        new RegExp(
          `[${String.fromCodePoint(0x1b)}${String.fromCodePoint(0x9b)}][#();?[]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\d<=>A-ORZcf-nqry]`,
          'g'
        ),
        ''
      )
  );
}
