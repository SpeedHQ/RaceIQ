import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
function csv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (quoted) { if(c==='"'&&text[i+1]==='"'){field+='"';i++;} else if(c==='"') quoted=false; else field+=c; }
    else if(c==='"') quoted=true;
    else if(c===","){row.push(field);field="";}
    else if(c==="\n"){row.push(field.replace(/\r$/, ""));rows.push(row);row=[];field="";}
    else field+=c;
  }
  if(field.length||row.length){row.push(field.replace(/\r$/, ""));rows.push(row);}
  return rows;
}
function atom(value) { return /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value; }
async function csvFile(path, hasHeader=true) {
  const rows=csv(await readFile(resolve(root,path),"utf8"));
  const headers=hasHeader?rows.shift():null;
  return rows.filter(r=>r.some(Boolean)).map(r=>headers?Object.fromEntries(headers.map((h,i)=>[h,atom(r[i]??"")])):r.map(atom));
}
async function json(path){return JSON.parse(await readFile(resolve(root,path),"utf8"));}
const catalogs = {
  fm:{cars:(await csvFile("packages/game-fm-2023-metadata/src/cars.csv",false)).map(([id,year,make,model])=>({id,year,make,model,name:`${year} ${make} ${model}`})),tracks:await csvFile("packages/game-fm-2023-metadata/src/tracks.csv")},
  f1:{drivers:await csvFile("packages/game-f1-2025-metadata/src/drivers.csv"),teams:await csvFile("packages/game-f1-2025-metadata/src/teams.csv"),tracks:await csvFile("packages/game-f1-2025-metadata/src/tracks.csv")},
  acc:{cars:await csvFile("packages/game-acc-metadata/src/cars.csv"),tracks:await csvFile("packages/game-acc-metadata/src/tracks.csv")},
  evo:{cars:await csvFile("packages/game-ac-evo-metadata/src/cars.csv"),tracks:await csvFile("packages/game-ac-evo-metadata/src/tracks.csv")},
  iracing:{cars:await csvFile("packages/game-iracing-metadata/src/cars.csv"),tracks:await csvFile("packages/game-iracing-metadata/src/tracks.csv")},
  lmu:{cars:(await json("packages/game-lmu-metadata/src/cars.json")).cars,tracks:(await json("packages/game-lmu-metadata/src/tracks.json")).tracks},
};
function extractObjects(source) {
  const out={}, constants=new Map();
  for(const match of source.matchAll(/(?:export )?const\s+([A-Za-z_]\w*)\s*=\s*([^;\n]+);/g)) constants.set(match[1],match[2]);
  function number(expression) {
    let value=expression.replace(/(\d)_(?=\d)/g,"$1");
    for(let i=0;i<constants.size;i++) value=value.replace(/\b[A-Za-z_]\w*\b/g,name=>constants.has(name)?`(${constants.get(name)})`:name);
    if(!/^[\d\s()+*/.-]+$/.test(value)) return null;
    try { const result=Function(`"use strict"; return (${value});`)(); return Number.isFinite(result)?result:null; } catch { return null; }
  }
  for(const match of source.matchAll(/export const (\w+)\s*=\s*\{/g)) {
    const start=match.index+match[0].length-1; let depth=0,end=start;
    for(;end<source.length;end++){if(source[end]==="{")depth++;else if(source[end]==="}"&&--depth===0)break;}
    const body=source.slice(start+1,end), values={};
    for(const line of body.split("\n")) {
      let m=line.match(/^\s*([A-Za-z_]\w*)\s*:\s*(-?\d[\d_]*)(?:\s*[,}]|\s*\/\/)/);
      if(m) values[m[1]]=Number(m[2].replaceAll("_",""));
      m=line.match(/^\s*([A-Za-z_]\w*)\s*:\s*\{\s*offset\s*:\s*([^,}]+)/);
      if(m) { const offset=number(m[2]); if(offset!==null) values[m[1]]=offset; }
    }
    out[match[1]]=values;
  }
  return out;
}
async function layouts(path) { return extractObjects(await readFile(resolve(root,path),"utf8")); }
const layoutInputs={
  fm:["packages/game-fm-2023/src/parser.ts"],
  acc:["packages/capture-formats/src/acc/structs.ts"],
  evo:["packages/capture-formats/src/ac-evo/structs.ts"],
  lmu:["packages/capture-formats/src/lmu/layout.ts"],
  f1:["packages/capture-formats/src/f1-2025/f1-wire.ts","packages/game-f1-2025/src/f1-packet-decoders.ts"],
  iracing:["packages/capture-formats/src/iracing/source-frame.ts","packages/capture-formats/src/iracing/source-frame-codec.ts","packages/capture-formats/src/iracing/variable-table.ts","packages/game-iracing/src/sdk-reader.ts"],
};
const sourceLayouts={};
for(const [name,paths] of Object.entries(layoutInputs)) {
  sourceLayouts[name]={};
  for(const path of paths) {
    Object.assign(sourceLayouts[name],await layouts(path));
    const source=await readFile(resolve(root,path),"utf8");
    for(const match of source.matchAll(/(?:export )?const (\w+)\s*=\s*(-?\d[\d_]*)/g)) sourceLayouts[name][match[1]]=Number(match[2].replaceAll("_",""));
    if(name==="evo") {
      const constants=new Map();
      for(const m of source.matchAll(/const\s+([A-Za-z_]\w*)\s*=\s*([^;\n]+);/g)) constants.set(m[1],m[2]);
      const resolve=(expression,seen=new Set())=>{
        let value=expression.replace(/(\d)_(?=\d)/g,"$1");
        value=value.replace(/\b[A-Za-z_]\w*\b/g,key=>{
          if(!constants.has(key)||seen.has(key)) return key;
          const next=new Set(seen);next.add(key);return `(${resolve(constants.get(key),next)})`;
        });
        if(!/^[\d\s()+*/.-]+$/.test(value)) return null;
        try { const result=Function(`"use strict"; return (${value});`)(); return Number.isFinite(result)?result:null; } catch { return null; }
      };
      const start=source.indexOf("export const GRAPHICS_EVO"), end=source.indexOf("} as const;",start);
      for(const line of source.slice(start,end).split("\n")) {
        const m=line.match(/^\s*([A-Za-z_]\w*)\s*:\s*\{\s*offset\s*:\s*([^,}]+)/);
        if(m) { const offset=resolve(m[2]); if(offset!==null) sourceLayouts.evo.GRAPHICS_EVO[m[1]]=offset; }
      }
    }
  }
  if(name==="evo") {
    const parser=await readFile(resolve(root,"packages/game-ac-evo/src/parser.ts"),"utf8");
    const compound=parser.match(/readCString\(graphicsBuf,\s*tyreLfBase\s*\+\s*(\d+),/);
    if(compound) sourceLayouts.evo.GRAPHICS_EVO.tyre_compound_offset=Number(compound[1]);
  }
  if(name==="fm") {
    const source=await readFile(resolve(root,paths[0]),"utf8"), packet={}, fields={};
    for(const m of source.matchAll(/^\s*([A-Za-z_]\w*)\s*:\s*[^\n]*?buf\.read(Float|Int32|UInt32|UInt16|UInt8|Int8)(?:LE)?\((\d+)\)/gm)) {
      packet[m[1]]=Number(m[3]); fields[m[1]]=m[2];
    }
    const raceOn=source.match(/const isRaceOn = buf\.readInt32LE\((\d+)\)/);
    if(raceOn){packet.IsRaceOn=Number(raceOn[1]);fields.IsRaceOn="Int32";}
    sourceLayouts.fm.packet=packet; sourceLayouts.fm._packetTypes=fields;
  }
  if(name==="f1") {
    const source=await readFile(resolve(root,paths[1]),"utf8"), decoders={};
    for(const match of source.matchAll(/export function decodeF1([A-Za-z0-9_]+)\([^]*?\)\s*:\s*[^{]+\{/g)) {
      const start=match.index+match[0].length-1;let depth=0,end=start;
      for(;end<source.length;end++){if(source[end]==="{")depth++;else if(source[end]==="}"&&--depth===0)break;}
      const body=source.slice(start+1,end), fields={};
      const size=body.match(/const size\s*=\s*(\d+)/);if(size)fields.size=Number(size[1]);
      const record=body.match(/\*\s*(\d+)\s*;/);if(record&&!fields.size)fields.size=Number(record[1]);
      for(const field of body.matchAll(/([A-Za-z_]\w*)\s*:\s*(?:data|body)\.read[A-Za-z0-9]+\(o(?:\s*\+\s*(\d+))?\)/g)) fields[field[1]]=Number(field[2]||0);
      for(const field of body.matchAll(/([A-Za-z_]\w*)\s*:\s*(?:data|body)\.read[A-Za-z0-9]+\((\d+)\)/g)) fields[field[1]]=Number(field[2]);
      for(const field of body.matchAll(/(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*(?:data|body)\.read[A-Za-z0-9]+\((\d+)\)/g)) fields[field[1]]=Number(field[2]);
      if(match[1]==="MotionEx") {
        let offset=0;const values=body.slice(body.indexOf("};")+2);
        for(const token of values.matchAll(/([A-Za-z_]\w*)\s*=\s*f\(\)|o\s*\+=\s*(\d+)/g)) {
          if(token[1]&&token[1]!=="f"){fields[token[1]]=offset;offset+=4;}
          else if(token[2])offset+=Number(token[2]);
        }
      }
      decoders[match[1]]=fields;
    }
    sourceLayouts.f1.decoders=decoders;
  }
}
const sdkSource=await readFile(resolve(root,"packages/game-iracing/src/sdk-reader.ts"),"utf8");
const sdkLayout={};
for(const match of sdkSource.matchAll(/const (\w+)\s*=\s*([\d_]+(?:\s*\*\s*[\d_]+)*)\s*;/g)) {
  sdkLayout[match[1]]=match[2].split("*").map(s=>Number(s.replaceAll("_","").trim())).reduce((a,b)=>a*b,1);
}
sourceLayouts.iracing.sdk=sdkLayout;
const toConst=(s)=>s.replace(/([a-z0-9])([A-Z])/g,"$1_$2").replace(/[^A-Za-z0-9]+/g,"_").toUpperCase();
const rust=[];
for(const [game,values] of Object.entries(sourceLayouts)) for(const [group,fields] of Object.entries(values)) {
  if(game==="f1"&&group==="decoders") {
    for(const [decoder,offsets] of Object.entries(fields)) for(const [field,value] of Object.entries(offsets)) if(typeof value==="number") rust.push(`pub const ${toConst(`${game}_decoders_${decoder}_${field}`)}: usize = ${value};`);
    continue;
  }
  if(typeof fields==="number") { rust.push(`pub const ${toConst(`${game}_${group}`)}: i64 = ${fields};`); continue; }
  for(const [field,value] of Object.entries(fields)) if(typeof value==="number") rust.push(`pub const ${toConst(`${game}_${group}_${field}`)}: ${value<0?"i64":"usize"} = ${value};`);
}
const fmTypes=sourceLayouts.fm._packetTypes;
for(const type of ["Float","Int32"]) {
  const special=new Set(["IsRaceOn","TimestampMS","LapNumber","TireWearFL","TireWearFR","TireWearRL","TireWearRR","TrackOrdinal"]);
  const fields=Object.entries(fmTypes).filter(([name,kind])=>kind===type&&!special.has(name));
  const name=type==="Float"?"FM_PACKET_FLOAT_FIELDS":"FM_PACKET_INT32_FIELDS";
  rust.push(`pub const ${name}: &[(&str, usize)] = &[${fields.map(([key])=>`("${key}", FM_PACKET_${toConst(key)})`).join(",")}];`);
}
delete sourceLayouts.fm._packetTypes;
const rootDir=resolve(root,"native/recorder/src/games/generated");
await mkdir(rootDir,{recursive:true});
await writeFile(resolve(rootDir,"catalogs.json"),JSON.stringify(catalogs)+"\n");
await writeFile(resolve(rootDir,"layouts.json"),JSON.stringify(sourceLayouts)+"\n");
await writeFile(resolve(rootDir,"layouts.rs"),"// Generated by native/recorder/tools/generate-game-catalogs.mjs. Do not edit.\n"+rust.join("\n")+"\n");
console.log(`generated game catalogs and compile-time layouts in ${rootDir}`);
