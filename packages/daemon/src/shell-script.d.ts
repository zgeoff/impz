// `bun build --compile` embeds a shell script imported with `{ type: 'text' }` in the binary
declare module '*.sh' {
  const text: string;

  export default text;
}
