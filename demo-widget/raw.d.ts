// `import text from './file.csv?raw'`: the file's contents as a string. Vite (the tests) does this
// natively; build.mjs has a plugin for the bundle.
declare module '*?raw' {
  const text: string
  export default text
}
