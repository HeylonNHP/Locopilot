/**
 * Module augmentation: adds `signal` (Abortable) to the option types for
 * `fs/promises.mkdir` and `fs/promises.stat`.
 *
 * The Node runtime has supported `AbortSignal` on these functions since
 * v14.8.0 / v15.7.0, but `@types/node` (v25.9.3 at time of writing) omits
 * `Abortable` from `MakeDirectoryOptions` and `StatOptions` — even though
 * it already includes it for `writeFile`, `readFile`, `copyFile`, and
 * `readdir`. This augmentation closes that gap so callers can pass
 * `{ signal }` without a type-erasing cast.
 *
 * When upstream eventually adds `Abortable` to these interfaces, this
 * declaration becomes a harmless no-op (declaration merging with
 * identical members).
 *
 * `appendFile` is NOT covered here because its options type is an
 * anonymous intersection (`ObjectEncodingOptions & FlagAndOpenMode &
 * { flush?: boolean }`) with no named interface to augment.  Call sites
 * for `appendFile` use a typed variable to bypass the excess-property
 * check instead.
 */
declare module 'node:fs' {
  interface MakeDirectoryOptions {
    signal?: AbortSignal | undefined;
  }

  interface StatOptions {
    signal?: AbortSignal | undefined;
  }
}
