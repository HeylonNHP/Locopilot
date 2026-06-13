/**
 * Interrupt handling for Locopilot.
 *
 * Manages the interrupt flag and cancellable handler registry.
 */

// Set to true by requestInterrupt(); cleared by clearInterrupt().
let interruptRequested = false;

// Resolvers registered by tools (e.g. run_command) so they can be
// cancelled from outside without waiting for the natural finish.
const interruptHandlers = new Map<number, (result: string) => void>();
let nextInterruptHandlerId = 1;

export function requestInterrupt(): void {
  interruptRequested = true;
  for (const handler of interruptHandlers.values()) {
    handler('[Interrupted by user.]');
  }
}

export function registerInterruptHandler(handler: (result: string) => void): number {
  const id = nextInterruptHandlerId++;
  interruptHandlers.set(id, handler);
  return id;
}

export function unregisterInterruptHandler(id?: number): void {
  if (id === undefined) {
    interruptHandlers.clear();
    return;
  }

  interruptHandlers.delete(id);
}

export function clearInterrupt(): void {
  interruptRequested = false;
}

export function isInterruptRequested(): boolean {
  return interruptRequested;
}
