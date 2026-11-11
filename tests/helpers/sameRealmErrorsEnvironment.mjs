import { TestEnvironment } from 'jest-environment-node';

/**
 * Jest's Node environment.
 *
 * Jest runs each test file in its own `vm` context, with its own `Error`.
 * Errors that Node's own modules raise - a reset socket, a failed `fs` call -
 * come from the MAIN realm, so `err instanceof Error` is false for them
 * inside a test file, although it is true in production (one realm). The
 * retry classifier in `src/services/retryable.ts` checks exactly that, so a
 * dropped stream would not look transient.
 *
 * This environment makes `instanceof Error` accept both realms. Other classes
 * (`TypeError` and the like) keep their normal behaviour.
 */
export default class SameRealmErrorsEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);

    const MainRealmError = Error;
    const SandboxError = this.global.Error;
    const defaultHasInstance = Function.prototype[Symbol.hasInstance];

    Object.defineProperty(SandboxError, Symbol.hasInstance, {
      configurable: true,
      value(instance) {
        // `TypeError` and friends inherit this method through the constructor
        // chain, so only `Error` itself is widened.
        if (this === SandboxError && instance instanceof MainRealmError) return true;
        return defaultHasInstance.call(this, instance);
      },
    });
  }
}
