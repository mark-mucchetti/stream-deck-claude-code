import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";

const sdPlugin = "com.virtuis.claudecode.sdPlugin";
const isWatching = !!process.env.ROLLUP_WATCH;
const banner = `/**!
 * Stream Deck × Claude Code
 * @copyright (c) ${new Date().getFullYear()} Mark Mucchetti
 */`;

/** @type {import('rollup').RollupOptions} */
const config = {
	input: "src/plugin.ts",
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		sourcemap: isWatching,
		sourcemapPathTransform: (relativePath) =>
			url.pathToFileURL(path.resolve(path.dirname(`${sdPlugin}/bin/plugin.js`), relativePath)).href,
		banner,
	},
	plugins: [
		{
			name: "watch-externals",
			buildStart() {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
			},
		},
		typescript({
			mapRoot: isWatching ? "./" : undefined,
		}),
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true,
		}),
		commonjs(),
		!isWatching && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: '{"type":"module"}', type: "asset" });
			},
		},
	],
};

export default config;
