import { createUniver, LocaleType, mergeLocales, greenTheme, defaultTheme } from '@univerjs/presets';
import { ICommandService } from '@univerjs/core';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import sheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US';
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import sheetsFilterEnUS from '@univerjs/preset-sheets-filter/locales/en-US';
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort';
import sheetsSortEnUS from '@univerjs/preset-sheets-sort/locales/en-US';
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting';
import sheetsCFEnUS from '@univerjs/preset-sheets-conditional-formatting/locales/en-US';
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation';
import sheetsDVEnUS from '@univerjs/preset-sheets-data-validation/locales/en-US';
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace';
import sheetsFREnUS from '@univerjs/preset-sheets-find-replace/locales/en-US';
import '@univerjs/preset-sheets-core/lib/index.css';
import '@univerjs/preset-sheets-filter/lib/index.css';
import '@univerjs/preset-sheets-sort/lib/index.css';
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css';
import '@univerjs/preset-sheets-data-validation/lib/index.css';
import '@univerjs/preset-sheets-find-replace/lib/index.css';
window.UniverBoot = function(container, workbookData, opts){
  opts = opts || {};
  // Excel wording for the ribbon (Univer says "Start", "Alignment and layout", "Number format"...)
  // Excel wording for the ribbon (Univer says "Start", "Alignment and layout", "Number format"). mergeLocales is shallow per namespace, so edit a copy.
  const excelLocale = JSON.parse(JSON.stringify(mergeLocales(sheetsCoreEnUS, sheetsFilterEnUS, sheetsSortEnUS, sheetsCFEnUS, sheetsDVEnUS, sheetsFREnUS)));
  try{ const rb = excelLocale.ui.ribbon; rb.start = 'Home'; rb.groups.layout = 'Alignment'; rb.groups.number = 'Number'; }catch(e){ console.error(e); }
  // green accents (selection, active tab) like Excel, but neutral grey grid lines / headers
  const excelTheme = Object.assign({}, greenTheme, { gray: defaultTheme.gray });
  const fonts = ['Saysettha OT','Phetsarath OT','Leelawadee UI','Noto Sans Lao','Calibri','Arial','Tahoma','Times New Roman','Segoe UI','Courier New'].map(function(f){ return {value:f, label:f}; });
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: excelLocale },
    theme: excelTheme,
    presets: [
      UniverSheetsCorePreset({ container, header: true, toolbar: true, footer: true, formulaBar: true, ribbonType: opts.ribbonType || 'grid', customFontFamily: fonts }),
      UniverSheetsFilterPreset(), UniverSheetsSortPreset(),
      UniverSheetsConditionalFormattingPreset(), UniverSheetsDataValidationPreset(), UniverSheetsFindReplacePreset(),
    ],
  });
  univerAPI.createWorkbook(workbookData);
  let cmdSvc = null;
  try { cmdSvc = univer.__getInjector().get(ICommandService); } catch(e) { console.error('no command service', e); }
  return {
    univer, univerAPI,
    // cb(commandId, params) for every executed command (selection/scroll noise filtered by caller)
    onCommand: function(cb){ if(!cmdSvc) return function(){}; const d = cmdSvc.onCommandExecuted(function(c){ try{ cb(c.id, c.params); }catch(e){ console.error(e); } }); return function(){ try{ d.dispose(); }catch(e){} }; },
    dispose: function(){ try{ univerAPI.dispose(); }catch(e){} try{ univer.dispose(); }catch(e){} },
  };
};
