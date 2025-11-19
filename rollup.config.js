// Rollup configuration for Obsidian plugin
import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

const isProd = process.env.BUILD === 'production';

export default {
  input: 'src/main.ts',
  output: {
    sourcemap: 'inline',
    sourcemapExcludeSources: isProd,
    format: 'cjs',
    exports: 'auto',
    file: 'main.js'
  },
  external: ['obsidian', 'obsidian-daily-notes-interface', 'electron', '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands', '@codemirror/language', '@codemirror/lint', '@codemirror/search', '@codemirror/state', '@codemirror/view', '@lezer/common', '@lezer/highlight', '@lezer/lr'],
  plugins: [
    typescript(),
    nodeResolve({ browser: true }),
    commonjs(),
  ]
};
