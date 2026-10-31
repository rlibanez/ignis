import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {readAppName,brandedAssets}=require('./app-name');
const {createI18n}=require('./web/i18n');
it('validates a display name with a compatible default',()=>{
 expect(readAppName({})).toBe('Ignis');expect(readAppName({IGNIS_APP_NAME:'  '})).toBe('Ignis');
 expect(readAppName({IGNIS_APP_NAME:' Mis notas '})).toBe('Mis notas');
 expect(readAppName({IGNIS_APP_NAME:'é'.repeat(80)})).toHaveLength(80);
 for(const name of ['a'.repeat(81),'bad\nname','\nname','a\u202eb','a\u2028b',12])expect(()=>readAppName({IGNIS_APP_NAME:name})).toThrow(/IGNIS_APP_NAME/);
});
it('changes presentation in both languages but preserves parameters and attribution',()=>{
 const appName='Notes $& {p0} <test>';
 const i18n=createI18n({__ignisAppName:appName,navigator:{language:'es'}});
 expect(i18n.t('Open Ignis')).toBe('Abrir '+appName);
 expect(i18n.t('Install Ignis')).toBe('Instalar '+appName);
 expect(i18n.t('Running in Ignis v{p0}',{p0:'1.0'})).toContain('Ignis v1.0');
 expect(i18n.t('Signed in as {p0}.',{p0:'Ignis'})).toContain('Ignis');
 expect(i18n.t('IGNIS_PUBLIC_ORIGIN')).toBe('IGNIS_PUBLIC_ORIGIN');
 i18n.setLanguage('en');expect(i18n.t('Open Ignis')).toBe('Open '+appName);
});
it('serializes hostile-looking names as literal data and keeps PWA identity stable',()=>{
 const manifest=fs.readFileSync(new URL('./web/manifest.webmanifest',import.meta.url));
 const original=new Map([['/manifest.webmanifest',{type:'application/manifest+json',content:manifest}],['/auth/i18n.js',{type:'text/javascript',content:Buffer.from('globalThis.loaded = true;')}]]);
 const name='</script>";globalThis.injected=true;//';
 const branded=brandedAssets(original,name),context={};
 vm.runInNewContext(branded.get('/auth/i18n.js').content,context);
 expect(context.__ignisAppName).toBe(name);expect(context.injected).toBeUndefined();expect(context.loaded).toBe(true);
 const data=JSON.parse(branded.get('/manifest.webmanifest').content);
 expect(data.name).toBe(name);expect(data.short_name).toBe(name);
 expect(data.id).toBe('/');expect(data.start_url).toBe('/');expect(data.scope).toBe('/');
 expect(JSON.parse(original.get('/manifest.webmanifest').content).name).toBe('Ignis');
 expect(JSON.parse(brandedAssets(original,'Other').get('/manifest.webmanifest').content).name).toBe('Other');
});
