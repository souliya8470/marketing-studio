How sheet/univer.js, univer.css and exceljs.js were built (esbuild, Univer presets v1.4.0 are ESM-only so there is no CDN UMD build):
  npm i @univerjs/presets @univerjs/preset-sheets-core @univerjs/preset-sheets-filter @univerjs/preset-sheets-sort \
        @univerjs/preset-sheets-conditional-formatting @univerjs/preset-sheets-data-validation @univerjs/preset-sheets-find-replace \
        rxjs react react-dom esbuild exceljs
  entry (src_entry.js) imports createUniver + the presets + their en-US locales + css, and defines window.UniverBoot(container, workbookData)
  returning {univer, univerAPI, onCommand(cb), dispose()}  (onCommand uses ICommandService from @univerjs/core).
  npx esbuild src_entry.js --bundle --minify --format=iife --outdir=out --entry-names=univer --loader:.css=css \
     --loader:.ttf=dataurl --loader:.woff=dataurl --loader:.woff2=dataurl --loader:.svg=dataurl --define:process.env.NODE_ENV='"production"'
  exceljs.js: entry = `import ExcelJS from 'exceljs/dist/exceljs.min.js'; window.ExcelJS = ExcelJS;` bundled the same way.
