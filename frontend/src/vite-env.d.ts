/// <reference types="vite/client" />

declare module '*.wasm?url' {
  const url: string;
  export default url;
}

declare module '*.worker.js?url' {
  const url: string;
  export default url;
}
