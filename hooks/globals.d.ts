// The hooks environment has the base64 methods of Uint8Array (the engine's
// own examples use them); TypeScript's es2023 lib does not declare them.
interface Uint8Array {
  toBase64(): string
}

interface Uint8ArrayConstructor {
  fromBase64(base64: string): Uint8Array<ArrayBuffer>
}
