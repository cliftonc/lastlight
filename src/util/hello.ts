export function sayHello(name: string): void {
  // Minimal implementation per issue #78: no trimming or fallback, just literal interpolation.
  // Callers are responsible for passing a suitable name.
  console.log(`Hello ${name}!`);
}
