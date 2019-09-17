const chalk = require('chalk');
const fs = require('fs-extra');
const gulp = require('gulp');
const gzipSize = require('gzip-size');
const path = require('path');
const {rollup} = require('rollup');
const babel = require('rollup-plugin-babel');
const commonjs = require('rollup-plugin-commonjs');
const resolve = require('rollup-plugin-node-resolve');
const replace = require('rollup-plugin-replace');
const terserRollupPlugin = require('rollup-plugin-terser').terser;
const {addAsset} = require('./utils/assets');
const {checkModuleDuplicates} = require('./utils/check-module-duplicates');
const {ENV} = require('./utils/env');
const config = require('../config.json');


/**
 * A Rollup plugin to generate a list of import dependencies for each entry
 * point in the module graph. This is then used by the template to generate
 * the necessary `<link rel="modulepreload">` tags.
 * @return {Object}
 */
const modulepreloadPlugin = () => {
  return {
    name: 'modulepreload',
    generateBundle(options, bundle) {
      // A mapping of entry chunk names to their full dependency list.
      const modulepreloadMap = {};

      // Loop through all the chunks to detect entries.
      for (const [fileName, chunkInfo] of Object.entries(bundle)) {
        if (chunkInfo.isEntry || chunkInfo.isDynamicEntry) {
          modulepreloadMap[chunkInfo.name] = [fileName, ...chunkInfo.imports];
        }
      }

      fs.outputJsonSync(
          path.join(config.publicDir, 'modulepreload.json'),
          modulepreloadMap, {spaces: 2});
    },
  };
};

/**
 * A Rollup plugin that will fail the build it two chunks are detected with
 * the same name. This is to avoid the issue described here (and need to be
 * used until it's resolved):
 * https://github.com/rollup/rollup/issues/3060#issuecomment-522719783
 * @return {Object}
 */
const checkDuplicateChunksPlugin = () => {
  return {
    name: 'manifest',
    generateBundle(options, bundle) {
      const chunkNames = new Set();

      for (const chunkInfo of Object.values(bundle)) {
        const name = chunkInfo.name;

        if (chunkNames.has(name)) {
          throw new Error(`Duplicate chunk name '${name}' detected`);
        }
        chunkNames.add(name);
      }
    },
  };
};

/**
 * A Rollup plugin that adds each chunk to the asset manifest, keyed by
 * the chunk name and the output extension, mapping to the file name.
 * @return {Object}
 */
const manifestPlugin = () => {
  return {
    name: 'manifest',
    generateBundle(options, bundle) {
      const ext = path.extname(options.entryFileNames);

      for (const [fileName, chunkInfo] of Object.entries(bundle)) {
        addAsset(chunkInfo.name + ext, fileName);
      }
    },
  };
};

const reportBundleSizePlugin = () => {
  let entryNames;
  return {
    name: 'bundle-size-plugin',
    buildStart: (inputOptions) => {
      entryNames = Object.keys(inputOptions.input);
    },
    generateBundle: (options, bundle) => {
      let bundleSize = 0;
      for (const [filename, chunkInfo] of Object.entries(bundle)) {
        const chunkSize = gzipSize.sync(chunkInfo.code);
        bundleSize += chunkSize;
        console.log(
            chalk.magenta(String(chunkSize).padStart(6)),
            chalk.gray(filename));
      }
      console.log(
          chalk.yellow(String(bundleSize).padStart(6)),
          chalk.white(`(total '${entryNames.join('/')}' bundle size)`));
    },
  };
};

const terserConfig = {
  mangle: {
    toplevel: true,
    // properties: {
    //   regex: /(^_|_$)/,
    // },
    safari10: true,
  },
};

const manualChunks = (id) => {
  if (id.includes('node_modules')) {
    // The directory name following the last `node_modules`.
    // Usually this is the package, but it could also be the scope.
    const directories = id.split(path.sep);
    return directories[directories.lastIndexOf('node_modules') + 1];
  }
};

let moduleBundleCache;

const compileModuleBundle = async () => {
  const plugins = [
    resolve(),
    commonjs(),
    replace({
      'process.env.NODE_ENV': JSON.stringify(ENV),
    }),
    checkDuplicateChunksPlugin(),
    modulepreloadPlugin(),
    reportBundleSizePlugin(),
    manifestPlugin(),
  ];
  if (ENV !== 'development') {
    plugins.push(terserRollupPlugin(terserConfig));
  }

  const bundle = await rollup({
    input: {
      'main-module': 'assets/javascript/main-module.js',
    },
    cache: moduleBundleCache,
    plugins,
    manualChunks,
    preserveSymlinks: true, // Needed for `file:` entries in package.json.
    treeshake: {
      pureExternalModules: true,
    },
  });

  moduleBundleCache = bundle.cache;

  checkModuleDuplicates(bundle.cache.modules.map((m) => m.id));

  await bundle.write({
    dir: config.publicStaticDir,
    format: 'esm',
    chunkFileNames: '[name]-[hash].mjs',
    entryFileNames: '[name]-[hash].mjs',

    // Don't rewrite dynamic import when developing (for easier debugging).
    dynamicImportFunction: ENV === 'development' ? undefined : '__import__',
  });
};

let nomoduleBundleCache;

const compileClassicBundle = async () => {
  const plugins = [
    resolve(),
    commonjs(),
    replace({
      'process.env.NODE_ENV': JSON.stringify(ENV),
    }),
    babel({
      exclude: [
        /core-js/,
        /regenerator-runtime/,
      ],
      presets: [['@babel/preset-env', {
        targets: {browsers: ['ie 11']},
        useBuiltIns: 'usage',
        // debug: true,
        loose: true,
        corejs: 3,
      }]],
      plugins: ['@babel/plugin-syntax-dynamic-import'],
    }),
    reportBundleSizePlugin(),
    manifestPlugin(),
  ];
  if (ENV !== 'development') {
    plugins.push(terserRollupPlugin(terserConfig));
  }

  const bundle = await rollup({
    input: {
      'main-nomodule': 'assets/javascript/main-nomodule.js',
    },
    cache: nomoduleBundleCache,
    plugins,
    inlineDynamicImports: true, // Need for a single output bundle.
    preserveSymlinks: true, // Needed for `file:` entries in package.json.
  });

  nomoduleBundleCache = bundle.cache;

  await bundle.write({
    dir: config.publicStaticDir,
    format: 'iife',
    entryFileNames: '[name]-[hash].js',
  });
};

gulp.task('javascript', async () => {
  try {
    await compileModuleBundle();

    if (ENV !== 'development') {
      await compileClassicBundle();
    }
  } catch (err) {
    // Beep!
    process.stdout.write('\x07');

    // Log but don't throw so watching still works.
    console.error(err);
  }
});
